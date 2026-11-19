output "gateway_private_ip" {
  description = "Address the agents use: http://<ip>:8787"
  value       = aws_instance.gateway.private_ip
}

output "secret_arn" {
  description = "Put a JSON object with the required keys here before the instance starts the gateway."
  value       = aws_secretsmanager_secret.gateway_env.arn
}

output "required_secret_keys" {
  description = "Keys the JSON secret must contain."
  value       = local.required_keys
}

output "session_manager_command" {
  description = "Shell access without SSH."
  value       = "aws ssm start-session --target ${aws_instance.gateway.id} --region ${var.region}"
}
