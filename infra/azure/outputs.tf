output "gateway_private_ip" {
  description = "Address the agents use: http://<ip>:8787"
  value       = azurerm_network_interface.gateway.private_ip_address
}

output "key_vault_name" {
  description = "Set these secrets here before the VM starts the gateway."
  value       = azurerm_key_vault.this.name
}

output "required_secrets" {
  description = "Key Vault secret names the gateway reads at start-up."
  value       = keys(local.secrets)
}
