import { generatePrincipalToken } from "../infrastructure/auth/principal-registry";

// Operator helper: prints a new ≥ 256-bit bearer token (hand it to the caller
// through the secret store, once) and the SHA-256 that goes into the
// principal registry. Only the hash is ever stored by the service.
const { token, tokenSha256 } = generatePrincipalToken();
console.log(JSON.stringify({ token, tokenSha256 }, null, 2));
