variable "region" {
  description = "AWS region. eu-west-2 (London) keeps data in the UK."
  type        = string
  default     = "eu-west-2"
}

variable "availability_zone" {
  description = "Pinned so the instance and its data volume never move if AWS adds a zone."
  type        = string
  default     = "eu-west-2a"
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "aag"
  validation {
    condition     = can(regex("^[a-z0-9-]{2,12}$", var.name_prefix))
    error_message = "The name_prefix must be 2-12 lowercase letters, digits or hyphens."
  }
}

variable "container_image" {
  description = "Gateway image, pinned by tag or digest."
  type        = string
  default     = "ghcr.io/idris-michael/agent-approval-gateway:0.1.0"
}

variable "vpc_cidr" {
  description = "Address space for the VPC."
  type        = string
  default     = "10.50.0.0/16"
}

variable "public_subnet_cidr" {
  description = "Holds only the NAT gateway."
  type        = string
  default     = "10.50.0.0/24"
}

variable "private_subnet_cidr" {
  description = "Holds the gateway instance."
  type        = string
  default     = "10.50.1.0/24"
}

variable "agents_cidr" {
  description = "Where the agents run. Only this range may reach the gateway's port."
  type        = string
  default     = "10.50.2.0/24"
}

variable "instance_type" {
  description = "Instance type. The gateway is light; t3.small leaves room for the container runtime."
  type        = string
  default     = "t3.small"
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default = {
    workload   = "agent-approval-gateway"
    managed_by = "terraform"
  }
}
