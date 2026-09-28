/**
 * The product is deployed separately from the public marketing site. Set this at build time to
 * the production app's customer sign-in URL; `/login` keeps a same-origin reverse-proxy setup
 * working for local development and deployments that route the product under the same domain.
 */
export const PRODUCT_LOGIN_URL = process.env.NEXT_PUBLIC_PRODUCT_LOGIN_URL?.trim() || '/login';
