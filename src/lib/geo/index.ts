import "server-only";

/**
 * Server-side geo resolution.
 *
 * The implementation lives in `./edge` because the middleware gate runs on the
 * Edge runtime and cannot import `server-only`. Server code imports from here.
 */
export { resolveGeoStatus, type GeoStatus } from "./edge";
export * from "./jurisdictions";
