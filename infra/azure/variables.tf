variable "subscription_id" {
  description = "Azure subscription to deploy into."
  type        = string
}

variable "location" {
  description = "Azure region. UK South keeps data in the UK."
  type        = string
  default     = "uksouth"
}

variable "name_prefix" {
  description = "Prefix for resource names (lowercase letters and digits)."
  type        = string
  default     = "aag"
  validation {
    condition     = can(regex("^[a-z0-9]{2,10}$", var.name_prefix))
    error_message = "The name_prefix must be 2-10 lowercase letters or digits."
  }
}

variable "container_image" {
  description = "Gateway image, pinned by tag or digest."
  type        = string
  default     = "ghcr.io/idris-michael/agent-approval-gateway:0.1.0"
}

variable "vnet_cidr" {
  description = "Address space for the gateway's virtual network."
  type        = string
  default     = "10.40.0.0/16"
}

variable "gateway_subnet_cidr" {
  description = "Subnet for the gateway VM."
  type        = string
  default     = "10.40.1.0/24"
}

variable "agents_subnet_cidr" {
  description = "Where the agents run. Only this range may reach the gateway's port."
  type        = string
  default     = "10.40.2.0/24"
}

variable "admin_ssh_public_key" {
  description = "Break-glass SSH key. There is no public IP; reach the VM through Azure Bastion if needed."
  type        = string
}

variable "vm_size" {
  description = "VM size. The gateway is light; B2s leaves room for the container runtime."
  type        = string
  default     = "Standard_B2s"
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default = {
    workload   = "agent-approval-gateway"
    managed_by = "terraform"
  }
}
