# One gateway VM in a private subnet. Single host by design (SQLite needs a local disk, see
# ADR 3). No public IP: approvals use outbound connections only, and only the agents' subnet
# can reach the API port. Secret values are set in Key Vault out of band, never in Terraform,
# so they never reach the state file.

data "azurerm_client_config" "current" {}

locals {
  name = "${var.name_prefix}-gateway"
  # Key Vault secret name = environment variable the gateway reads
  secrets = {
    "telegram-bot-token"   = "TELEGRAM_BOT_TOKEN"
    "approver-chat-id"     = "APPROVER_CHAT_ID"
    "finance-approver-id"  = "FINANCE_APPROVER_ID"
    "ops-approver-id"      = "OPS_APPROVER_ID"
    "approval-hmac-secret" = "APPROVAL_HMAC_SECRET"
    "agent-api-key"        = "AGENT_API_KEY"
    "viewer-api-key"       = "VIEWER_API_KEY"
  }
}

resource "azurerm_resource_group" "this" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = var.tags
}

# ---------- Network ----------

resource "azurerm_virtual_network" "this" {
  name                = "vnet-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  address_space       = [var.vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "gateway" {
  name                            = "snet-gateway"
  resource_group_name             = azurerm_resource_group.this.name
  virtual_network_name            = azurerm_virtual_network.this.name
  address_prefixes                = [var.gateway_subnet_cidr]
  service_endpoints               = ["Microsoft.KeyVault"]
  default_outbound_access_enabled = false
}

resource "azurerm_subnet" "agents" {
  name                            = "snet-agents"
  resource_group_name             = azurerm_resource_group.this.name
  virtual_network_name            = azurerm_virtual_network.this.name
  address_prefixes                = [var.agents_subnet_cidr]
  default_outbound_access_enabled = false
}

resource "azurerm_network_security_group" "gateway" {
  name                = "nsg-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags

  security_rule {
    name                       = "allow-agents-to-api"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "8787"
    source_address_prefix      = var.agents_subnet_cidr
    destination_address_prefix = var.gateway_subnet_cidr
  }

  security_rule {
    name                       = "deny-all-other-inbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_network_security_group" "agents" {
  name                = "nsg-${var.name_prefix}-agents"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags

  security_rule {
    name                       = "deny-all-inbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "gateway" {
  subnet_id                 = azurerm_subnet.gateway.id
  network_security_group_id = azurerm_network_security_group.gateway.id
}

resource "azurerm_subnet_network_security_group_association" "agents" {
  subnet_id                 = azurerm_subnet.agents.id
  network_security_group_id = azurerm_network_security_group.agents.id
}

# Outbound only (Telegram, image registry, payments API) through a NAT gateway
resource "azurerm_public_ip" "nat" {
  name                = "pip-${local.name}-nat"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = ["1"]
  tags                = var.tags
}

resource "azurerm_nat_gateway" "this" {
  name                = "ng-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  sku_name            = "Standard"
  zones               = ["1"]
  tags                = var.tags
}

resource "azurerm_nat_gateway_public_ip_association" "this" {
  nat_gateway_id       = azurerm_nat_gateway.this.id
  public_ip_address_id = azurerm_public_ip.nat.id
}

resource "azurerm_subnet_nat_gateway_association" "gateway" {
  subnet_id      = azurerm_subnet.gateway.id
  nat_gateway_id = azurerm_nat_gateway.this.id
}

# ---------- Identity and secrets ----------

resource "azurerm_user_assigned_identity" "gateway" {
  name                = "id-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags
}

resource "azurerm_key_vault" "this" {
  #checkov:skip=CKV_AZURE_189:Access is limited by the vault firewall to the gateway subnet's service endpoint; a private endpoint is the production upgrade (handover).
  #checkov:skip=CKV2_AZURE_32:Same as above; service endpoint plus firewall for the pilot.
  name                          = "kv-${var.name_prefix}-${substr(sha1(azurerm_resource_group.this.id), 0, 8)}"
  location                      = azurerm_resource_group.this.location
  resource_group_name           = azurerm_resource_group.this.name
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  public_network_access_enabled = true
  tags                          = var.tags

  network_acls {
    default_action             = "Deny"
    bypass                     = "None"
    virtual_network_subnet_ids = [azurerm_subnet.gateway.id]
  }

  lifecycle {
    prevent_destroy = true
  }
}

# The gateway can read secret values and nothing else
resource "azurerm_role_assignment" "gateway_reads_secrets" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.gateway.principal_id
}

# ---------- Compute ----------

resource "azurerm_network_interface" "gateway" {
  name                = "nic-${local.name}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = var.tags

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.gateway.id
    private_ip_address_allocation = "Dynamic"
  }
}

# Holds the approvals, queue and audit log
resource "azurerm_managed_disk" "data" {
  #checkov:skip=CKV_AZURE_93:Platform-managed keys encrypt the disk at rest; customer-managed keys via a disk encryption set are a production upgrade.
  name                          = "disk-${local.name}-data"
  location                      = azurerm_resource_group.this.location
  resource_group_name           = azurerm_resource_group.this.name
  storage_account_type          = "StandardSSD_LRS"
  create_option                 = "Empty"
  disk_size_gb                  = 16
  zone                          = "1"
  public_network_access_enabled = false
  network_access_policy         = "DenyAll"
  tags                          = var.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_linux_virtual_machine" "gateway" {
  name                            = "vm-${local.name}"
  location                        = azurerm_resource_group.this.location
  resource_group_name             = azurerm_resource_group.this.name
  size                            = var.vm_size
  zone                            = "1"
  admin_username                  = "gatewayadmin"
  disable_password_authentication = true
  allow_extension_operations      = false
  encryption_at_host_enabled      = true
  network_interface_ids           = [azurerm_network_interface.gateway.id]
  tags                            = var.tags

  admin_ssh_key {
    username   = "gatewayadmin"
    public_key = var.admin_ssh_public_key
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.gateway.id]
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
    identity_client_id = azurerm_user_assigned_identity.gateway.client_id
    vault_uri          = azurerm_key_vault.this.vault_uri
    container_image    = var.container_image
    secret_map         = join(" ", [for name, env in local.secrets : "${name}=${env}"])
  }))

  boot_diagnostics {}
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.gateway.id
  lun                = 0
  caching            = "ReadWrite"
}
