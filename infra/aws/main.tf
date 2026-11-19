# One gateway instance in a private subnet. Single host by design (SQLite needs a local disk,
# see ADR 3). No public IP and no SSH: access is through SSM Session Manager. Secret values are
# put into Secrets Manager out of band, never in Terraform, so they never reach the state file.

data "aws_caller_identity" "current" {}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  name          = "${var.name_prefix}-gateway"
  az            = var.availability_zone
  required_keys = ["TELEGRAM_BOT_TOKEN", "APPROVER_CHAT_ID", "FINANCE_APPROVER_ID", "OPS_APPROVER_ID", "APPROVAL_HMAC_SECRET", "AGENT_API_KEY", "VIEWER_API_KEY"]
}

# ---------- Encryption ----------

resource "aws_kms_key" "gateway" {
  description         = "${local.name}: data volume, secrets and logs"
  enable_key_rotation = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.region}.amazonaws.com" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
        Condition = {
          ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:*" }
        }
      },
    ]
  })
}

# ---------- Network ----------

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-${local.name}" }
}

# No rules: nothing may use the default security group
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/vpc/${local.name}/flow-logs"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.gateway.arn
}

resource "aws_iam_role" "flow_logs" {
  name = "${local.name}-flow-logs"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "vpc-flow-logs.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "write-flow-logs"
  role = aws_iam_role.flow_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.flow_logs.arn}:*"
    }]
  })
}

resource "aws_flow_log" "this" {
  vpc_id          = aws_vpc.this.id
  traffic_type    = "ALL"
  log_destination = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn    = aws_iam_role.flow_logs.arn
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = local.az
  map_public_ip_on_launch = false
  tags                    = { Name = "public-nat-only" }
}

resource "aws_subnet" "private" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.private_subnet_cidr
  availability_zone = local.az
  tags              = { Name = "private-gateway" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "gateway" {
  name        = "${local.name}-sg"
  description = "Gateway: API from the agents only; HTTPS out for Telegram, images and AWS APIs"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "Agents call the gateway API"
    from_port   = 8787
    to_port     = 8787
    protocol    = "tcp"
    cidr_blocks = [var.agents_cidr]
  }

  egress {
    description = "HTTPS out: Telegram, container registry, Secrets Manager, SSM, package repos"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------- Secrets and identity ----------

resource "aws_secretsmanager_secret" "gateway_env" {
  #checkov:skip=CKV2_AWS_57:Rotated by the runbook procedure; rotating the HMAC secret invalidates pending cards, so it is a planned operation, not a timer.
  name        = "${local.name}/env"
  description = "JSON object of the gateway's environment variables. Value set out of band."
  kms_key_id  = aws_kms_key.gateway.arn
}

resource "aws_iam_role" "gateway" {
  name = "${local.name}-instance"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

# The instance can read its one secret and nothing else
resource "aws_iam_role_policy" "read_secret" {
  name = "read-gateway-secret"
  role = aws_iam_role.gateway.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = aws_secretsmanager_secret.gateway_env.arn },
      { Effect = "Allow", Action = "kms:Decrypt", Resource = aws_kms_key.gateway.arn },
    ]
  })
}

# Session Manager instead of SSH: no key pairs, no open port, sessions are logged
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.gateway.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "gateway" {
  name = "${local.name}-instance"
  role = aws_iam_role.gateway.name
}

# ---------- Compute ----------

# Holds the approvals, queue and audit log
resource "aws_ebs_volume" "data" {
  #checkov:skip=CKV2_AWS_9:AWS Backup for this volume is a production item in the handover; the pilot keeps no real customer data.
  availability_zone = local.az
  size              = 16
  type              = "gp3"
  encrypted         = true
  kms_key_id        = aws_kms_key.gateway.arn
  tags              = { Name = "${local.name}-data" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "gateway" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.private.id
  vpc_security_group_ids = [aws_security_group.gateway.id]
  iam_instance_profile   = aws_iam_instance_profile.gateway.name
  ebs_optimized          = true
  monitoring             = true

  # IMDSv2 only, and a hop limit of 1 so the container can't reach the instance's credentials
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    encrypted   = true
    kms_key_id  = aws_kms_key.gateway.arn
    volume_type = "gp3"
    volume_size = 20
  }

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    region           = var.region
    secret_arn       = aws_secretsmanager_secret.gateway_env.arn
    container_image  = var.container_image
    volume_id_nodash = replace(aws_ebs_volume.data.id, "-", "")
    required_keys    = join(" ", local.required_keys)
  })

  tags = { Name = local.name }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.gateway.id
}
