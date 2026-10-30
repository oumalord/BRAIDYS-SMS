# Paystack Payroll Setup

Paystack payroll uses the existing unpaid KES earnings calculation. The browser sends selected staff IDs only; the backend calculates payable amounts and uses each staff member's Paystack recipient code.

## Backend Configuration

Set `PAYSTACK_SECRET_KEY` in the backend environment. Never add a secret key to frontend variables or commit it to source control.

Set `PAYSTACK_TRANSFER_AMOUNT_MULTIPLIER=100` for KES subunits.

With a live key configured, staff onboarding and phone-number updates automatically create or refresh a KES M-PESA transfer recipient and save its code to the staff profile. The staff profile phone is also the phone used to register the employee account, and profile edits keep the account phone synchronized. Existing staff missing a live recipient code are provisioned automatically before their first payout. The backend validates Kenyan mobile numbers and verifies Paystack's returned recipient type and currency; recipient account details remain in Paystack.

An owner can use **Finance → Unpaid payroll → Sync recipients** to provision missing recipients for all eligible staff in the salon, including receptionists. Administrator roles are excluded. This action only registers recipients; it does not send payments. Review any reported phone or Paystack errors before sending payroll.

## Paystack Dashboard

Bulk transfer requires the transfer OTP requirement to be disabled for the Paystack integration. Configure the webhook URL as `https://YOUR_DOMAIN/api/paystack/webhook` and subscribe to `transfer.success`, `transfer.failed`, and `transfer.reversed`.

Only a valid `x-paystack-signature` webhook can finalize a payroll payment. Successful transfers create payout records; failed transfers remain unpaid, and reversed transfers reopen the earnings. An interrupted submission is marked unknown and must be checked in Paystack before retrying. Payroll sending is disabled unless the backend has an `sk_live_` secret key.

The app does not store or request the secret key. Keep the live secret only in the backend environment, never in frontend variables or source control. A test key is rejected for payroll sends.