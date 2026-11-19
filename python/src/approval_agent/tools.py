"""Tools for the fictional lender's support agent ("Northgate Lending" is made up).

Read-only tools run here, in the agent. Sensitive tools are schemas only: the model can ask for
them, but the code that moves money lives behind the gateway, which runs it after approval."""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool

# Stub records so the demo runs offline. A real deployment calls the core banking API here.
_CUSTOMERS: dict[str, dict[str, Any]] = {
    "C-1042": {
        "name": "A. Customer (test record)",
        "loan": "personal loan, £4,800, 24 months",
        "recent_payments": [
            {"date": "2026-10-01", "amount_gbp": 40.0, "ref": "OCT-INSTALMENT"},
            {"date": "2026-10-01", "amount_gbp": 40.0, "ref": "OCT-INSTALMENT"},
            {"date": "2026-09-01", "amount_gbp": 40.0, "ref": "SEP-INSTALMENT"},
        ],
    },
}


@tool
def lookup_customer(customer_id: str) -> str:
    """Look up a customer's loan and recent payments by customer id (for example C-1042)."""
    record = _CUSTOMERS.get(customer_id)
    if record is None:
        return f"No customer with id {customer_id}."
    payments = "; ".join(f"{p['date']} £{p['amount_gbp']:.2f} {p['ref']}" for p in record["recent_payments"])
    return f"{customer_id}: {record['name']}. Loan: {record['loan']}. Recent payments: {payments}."


@tool
def issue_refund(customer_id: str, amount_gbp: float, reason_code: str, reason: str) -> str:
    """Refund money to a customer. Needs human approval; the gateway runs it once approved.
    reason_code is one of duplicate_charge, goodwill, error_correction. reason is one sentence
    explaining why, shown to the approver."""
    raise RuntimeError("issue_refund runs in the approval gateway, never in the agent")


@tool
def send_invoice(customer_id: str, amount_gbp: float, reason: str) -> str:
    """Send an invoice to a customer. Needs human approval; the gateway runs it once approved."""
    raise RuntimeError("send_invoice runs in the approval gateway, never in the agent")


LOCAL_TOOLS = {"lookup_customer": lookup_customer}
ALL_TOOLS = [lookup_customer, issue_refund, send_invoice]
