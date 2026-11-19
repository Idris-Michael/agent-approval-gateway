# Infrastructure

> **Not deployed.** Both stacks pass `terraform validate`, TFLint (recommended preset plus the cloud
> ruleset) and Checkov with no failures. They have not been applied to a real subscription or account.

Same shape on both clouds, because the design asks for it:

- **One VM, local encrypted disk.** The gateway's SQLite stores need a local filesystem (network
  shares break SQLite's locking), and a single host is what [ADR 3](../docs/adr/0003-sqlite-conditional-update.md)
  describes. The data volume has `prevent_destroy`, since it holds the audit log.
- **No public IP, no inbound internet.** Approvals use outbound connections only (Telegram long
  polling). The API port accepts traffic from the agents' subnet and nothing else. Outbound goes
  through a NAT gateway.
- **Secrets never touch Terraform.** The VM's own identity reads them from Key Vault or Secrets
  Manager at each start, into `/run` (memory). Terraform creates the vault and the permission, not
  the values, so the state file holds no secrets.
- **Least privilege.** The identity can read the gateway's secrets and nothing else.
- **Hardened container run:** read-only root filesystem, all Linux capabilities dropped,
  `no-new-privileges`, non-root user.

| | Azure (`azure/`) | AWS (`aws/`) |
|---|---|---|
| Region default | UK South | eu-west-2 (London) |
| Compute | Ubuntu 24.04 VM, encryption at host, extensions disabled | Amazon Linux 2023, IMDSv2 only, hop limit 1 (the container can't reach instance credentials) |
| Secrets | Key Vault: RBAC, purge protection, firewall to the gateway subnet | Secrets Manager, KMS key with rotation |
| Admin access | SSH key, no public IP (use Bastion) | SSM Session Manager, no SSH |
| Network logging | NSGs on both subnets | VPC flow logs to KMS-encrypted CloudWatch (1 year) |
| Checkov | 27 passed, 0 failed, 3 skipped | 65 passed, 0 failed, 1 skipped |

Every skipped check has its reason written next to it in the code (for example: private endpoint
for Key Vault and customer-managed disk keys are production upgrades, listed in the handover).

## Before applying
1. Publish the image and set `container_image` to a pinned tag or digest.
2. Azure: `encryption_at_host_enabled` needs the `EncryptionAtHost` feature registered on the
   subscription.
3. After `apply`, set the secret values (names are in the outputs), then restart the service on
   the VM. The service refuses to start while any value is missing.

## Check locally
```bash
cd infra/azure   # or infra/aws
terraform init -backend=false && terraform validate
tflint --init && tflint
checkov -d . --framework terraform
```
