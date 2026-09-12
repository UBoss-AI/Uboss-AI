import Link from 'next/link';

/**
 * Bootstrap landing page.
 *
 * Deliberately not a product screen. The Login experience (six-section left presentation:
 * MAP, Optimize, Build, Operate, Govern, Manage Task) and the authenticated dashboards are
 * built in later prompts; there is no public company signup at any point.
 */
export default function HomePage() {
  return (
    <main style={{ maxWidth: 560, margin: '48px auto', padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 800 }}>UBOSS AI AMS</h1>
      <p style={{ color: '#54637a', marginTop: 6 }}>
        Repository foundation is in place. Product screens are added one prompt at a time.
      </p>
      <p style={{ marginTop: 20 }}>
        <Link href="/login" className="uboss-link">
          Sign in &rarr;
        </Link>
      </p>
      <p style={{ marginTop: 8 }}>
        <Link href="/design-system" className="uboss-link">
          UBoss design system &amp; shells →
        </Link>
      </p>
      <p style={{ marginTop: 8 }}>
        <Link href="/health" className="uboss-link">
          Platform health check →
        </Link>
      </p>
    </main>
  );
}
