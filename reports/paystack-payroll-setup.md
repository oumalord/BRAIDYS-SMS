# Paystack Payroll Setup

Paystack payroll uses the existing unpaid KES earnings calculation. The browser sends selected staff IDs only; the backend calculates the payable amounts and uses each staff member's Paystack recipient code.

## Backend Configuration

Set `PAYSTACK_SECRET_KEY` in the backend environment. Never add a secret key to frontend variables or commit it to source control.

`PAYSTACK_TRANSFER_AMOUNT_MULTIPLIER` defaults to `100`. Confirm the amount unit Paystack expects for your KES transfer account before sending a live batch.

Create each staff member as a transfer recipient in Paystack and save the resulting `RCP_...` recipient code in that staff member's **Staff & Chairs → Edit details** form. Recipient account details stay in Paystack.

## Paystack Dashboard

Bulk transfer requires the transfer OTP requirement to be disabled for the Paystack integration. Configure the webhook URL as `https://YOUR_DOMAIN/api/paystack/webhook` and subscribe to `transfer.success`, `transfer.failed`, and `transfer.reversed`.

Only a valid `x-paystack-signature` webhook can finalize a payroll payment. Successful transfers create payout records; failed transfers remain unpaid, and reversed transfers reopen the earnings. An interrupted submission is marked unknown and must be checked in Paystack before retrying.

Test the full flow with Paystack test credentials and test recipients before switching to live credentials. The app does not store or request the secret key.