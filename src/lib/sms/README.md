# SMS module

Provider-independent SMS layer. `types.ts` defines the `SmsProvider`
contract; Telnyx and Twilio adapters will implement it in Ticket 5. No
provider SDK is integrated yet. Application code must depend only on the
interface, never on a concrete provider.
