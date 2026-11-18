# Eliza Completed Appointments and Earnings Trace: 24-30 October 2026

- Period: 24 October 2026 through 30 October 2026, inclusive
- Timezone: Africa/Nairobi
- Staff: Eliza, Main Branch
- Source: live appointments, orders, payout items, payroll items, payroll batches, and matching order audit events
- This is a read-only audit. No database records were changed.

## Findings

- 9 completed appointments were assigned to Eliza; all 9 have linked orders.
- Calculated commission across these appointments: KES 8,045.
- No active payout markers were found for these earning lines.
- Five Paystack payroll attempts on 31 October are recorded as `failed` with the reason `You cannot initiate third party payouts at this time`. No successful transfer or payout marker was found.
- Each failed attempt records KES 10,495, but its saved nine-line earning snapshot totals KES 8,045. The KES 2,450 mismatch needs investigation before retrying or adjusting payroll.

## Appointment List

| Appointment date | Card number | Customer | Service | Commission (KES) | Order ID |
| --- | ---: | --- | --- | ---: | --- |
| 24 Oct | 22 | Dianah | ponytail | 780 | `fcd24bb9-fcfa-4ca5-aaa1-23f7f0f655bb` |
| 24 Oct | 5 | Eunice | marley angel | 975 | `aad8897a-9fb1-422c-b70f-3b57526f8eca` |
| 24 Oct | 32 | Mercy | knotless | 1,000 | `47c67c81-2bb3-4dda-9063-a5fa06454250` |
| 25 Oct | 18 | Christine mueni | miracle knots | 850 | `70e498df-6ca6-47c3-b62c-5ff58f86538f` |
| 26 Oct | 5 | Marry | knotless | 780 | `1f1275e9-8b63-4776-ac3d-5f94b758a1cf` |
| 28 Oct | 7 | Zippora | ponytail | 1,050 | `44948b63-e1cc-4b1d-9cc5-67f4f68c5621` |
| 29 Oct | 33 | Damaris | knotless | 850 | `6f4b3633-99a4-44e2-a9ad-f24325578a36` |
| 29 Oct | 5 | Marry | knotless | 780 | `9c0f5368-bf13-4c8a-9435-c579437029a4` |
| 30 Oct | 8 | Ghagei yien | Knotless | 980 | `453a68d6-87fb-420b-91ac-49bcc31d6cfe` |
| **Total** |  |  |  | **8,045** | 9 completed appointments |

## Payroll Attempts

All attempts were for KES 10,495 and failed before payment. They are listed separately because the repeated attempts do not represent completed payments.

| Attempt time (Nairobi) | Status | Amount (KES) | Payroll item ID | Reference | Failure |
| --- | --- | ---: | --- | --- | --- |
| 31 Oct 19:24:34 | Failed | 10,495 | `5367f9bf-ba6d-4cb6-874f-c036ad0c56b0` | `braidy-fb4f55c892f1a59e644cf7cc6c665f213883` | Third-party payouts unavailable |
| 31 Oct 19:25:07 | Failed | 10,495 | `2839c4c6-6da5-4c00-8176-5b7f68fd80af` | `braidy-33151303fb6baf304bfa0c90cc57b89a873d` | Third-party payouts unavailable |
| 31 Oct 19:26:20 | Failed | 10,495 | `f7a120ef-b3c7-43e2-a61e-4d2b288bbe30` | `braidy-044c02c820307e816361e98b50991fbbd8ea` | Third-party payouts unavailable |
| 31 Oct 19:39:17 | Failed | 10,495 | `5431a22e-371e-4e19-911a-4d17d9b85ecb` | `braidy-6d4e6dcbe41dd7d38469f7487ac37d4d7988` | Third-party payouts unavailable |
| 31 Oct 19:39:39 | Failed | 10,495 | `95988352-86af-48cc-b104-0bac91b6d4d1` | `braidy-bffa8097ec1b5eaf219e5aa20e82a0ce5236` | Third-party payouts unavailable |

## Audit Note

The payable commission currently traced to these completed appointments is KES 8,045. The failed payroll amount is KES 2,450 higher, despite the saved earning-line snapshot summing to KES 8,045. Do not retry the mismatched transfer amount until the payroll calculation or stored payroll item is reconciled.
