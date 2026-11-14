export const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
/** null, `{}` and `[]` carry nothing worth showing. */
export const present = (v: unknown) =>
   v != null && !(typeof v === "object" && Object.keys(v).length === 0);
