import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PRODUCT_LOGIN_URL } from '@/lib/product-login';

export const metadata: Metadata = {
  title: 'Sign In',
  description: 'Sign in to Chief Agent, powered by UBoss AI.',
};

/**
 * Send sign-in requests to the product's real login screen. Authentication stays on the product
 * origin; the marketing website never collects credentials.
 */
export default function SignInPage() {
  redirect(PRODUCT_LOGIN_URL);
}
