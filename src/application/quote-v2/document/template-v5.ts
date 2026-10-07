import { TEMPLATE_V4 } from "./template-v4";

/** R1.7A production content release: approved U2 copy, new issuer profile v2.
 * Every displayed template string is unchanged. V4 stays archived verbatim
 * for snapshots pinned to issuer v1 and the unchanged renderer/assets.
 */
export const TEMPLATE_VERSION = "quote-pdf-template-v5";
export const TEMPLATE_V5_CONTENT_STATUS = { taxWording: "approved" } as const;
export const TEMPLATE_V5 = TEMPLATE_V4;
