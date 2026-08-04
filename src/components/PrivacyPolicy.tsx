import React from "react";
import { Logo } from "./Logo";

interface PrivacyPolicyProps {
  onBack?: () => void;
}

export function PrivacyPolicy({ onBack }: PrivacyPolicyProps) {
  return (
    <div style={{ background: "#0e0f0e", color: "#f7f7f3", minHeight: "100vh", fontFamily: "'Inter', sans-serif" }}>
      {/* Header */}
      <header style={{
        borderBottom: "1px solid #232521",
        padding: "18px 32px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        maxWidth: "1100px",
        margin: "0 auto",
      }}>
        <div style={{ cursor: "pointer" }} onClick={onBack}>
          <Logo dark />
        </div>
        {onBack && (
          <button
            onClick={onBack}
            style={{
              background: "#1f201d",
              color: "#a4ef51",
              border: "1px solid #383a35",
              padding: "8px 16px",
              borderRadius: "8px",
              fontSize: "13px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            ← Return to GrowthSent
          </button>
        )}
      </header>

      {/* Content Container */}
      <main style={{ maxWidth: "860px", margin: "0 auto", padding: "48px 24px 80px 24px" }}>
        <div style={{ marginBottom: "36px" }}>
          <span style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "1px", color: "#a4ef51", fontWeight: 700 }}>
            LEGAL &amp; PRIVACY
          </span>
          <h1 style={{ fontSize: "36px", fontWeight: 800, margin: "8px 0 12px 0", color: "#f7f7f3" }}>
            Privacy Policy
          </h1>
          <p style={{ color: "#888982", fontSize: "14px", margin: 0 }}>
            Last updated: August 4, 2026
          </p>
        </div>

        <div style={{ fontSize: "15px", lineHeight: "1.7", color: "#d1d2cc", display: "flex", flexDirection: "column", gap: "28px" }}>
          <p style={{ fontSize: "16px", color: "#e4e5e0" }}>
            GrowthSent, Inc. (&quot;GrowthSent,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) operates the GrowthSent website, application, and related services (collectively, the &quot;Service&quot;).
            This Privacy Policy explains how we collect, use, store, and protect information when you use GrowthSent.
            By using GrowthSent, you agree to the practices described in this Privacy Policy.
          </p>

          {/* Section 1 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>1. Information We Collect</h2>
            <p>We collect information in several ways depending on how you use GrowthSent.</p>

            <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "16px 0 8px 0", color: "#f7f7f3" }}>1.1 Information You Provide</h3>
            <p>When you create an account or use certain features, we may collect information such as:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Name</li>
              <li>Email address</li>
              <li>Account credentials</li>
              <li>Website URLs</li>
              <li>Company or project information</li>
              <li>Information you provide through support requests or communications</li>
            </ul>
            <p>We only collect information reasonably necessary to provide and improve the Service.</p>

            <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "20px 0 8px 0", color: "#f7f7f3" }}>1.2 Public Website Data</h3>
            <p>GrowthSent allows users to enter a publicly accessible website URL for analysis.</p>
            <p>When you request a website scan, GrowthSent may automatically access and process publicly available information from that website, including:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Web pages</li>
              <li>Page titles</li>
              <li>Meta descriptions</li>
              <li>Headings</li>
              <li>Links</li>
              <li>HTTP status codes</li>
              <li>Robots.txt</li>
              <li>XML sitemaps</li>
              <li>Canonical tags</li>
              <li>Indexability-related signals</li>
              <li>Other publicly accessible technical and SEO-related information</li>
            </ul>
            <p>GrowthSent does not require website owners to provide private credentials to perform a basic public website scan.</p>
            <p style={{ fontStyle: "italic", color: "#aaaaa2" }}>You should only submit URLs that you are authorized to analyze.</p>
          </section>

          {/* Section 2 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>2. Google Integrations</h2>
            <p>GrowthSent may allow you to connect third-party services, including Google Search Console and Google Analytics 4 (&quot;Google Services&quot;).</p>
            <p>If you choose to connect a Google Service, GrowthSent may access data that you explicitly authorize through Google&apos;s OAuth authorization process.</p>
            <p>Depending on the integration and permissions granted, this may include information such as:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Search performance data</li>
              <li>Search queries</li>
              <li>Impressions</li>
              <li>Clicks</li>
              <li>Click-through rates</li>
              <li>Average search position</li>
              <li>Website traffic data</li>
              <li>Analytics metrics</li>
              <li>Website performance information</li>
            </ul>
            <p>GrowthSent only requests access to information necessary to provide the features you choose to use.</p>
            <p>You can revoke GrowthSent&apos;s access to your Google account at any time through your Google account settings.</p>
            <div style={{ background: "#1f201d", borderLeft: "3px solid #a4ef51", padding: "14px 18px", borderRadius: "6px", marginTop: "16px" }}>
              <p style={{ margin: 0, fontWeight: 600, color: "#f7f7f3" }}>
                GrowthSent&apos;s use of information received from Google APIs will comply with Google&apos;s API Services User Data Policy, including the Limited Use requirements where applicable.
              </p>
              <ul style={{ paddingLeft: "20px", margin: "8px 0 0 0", color: "#aaaaa2" }}>
                <li>GrowthSent does not sell Google user data.</li>
                <li>We do not use Google user data for advertising purposes.</li>
                <li>We do not use Google user data to determine creditworthiness, insurance eligibility, employment eligibility, or similar sensitive decisions.</li>
              </ul>
            </div>
          </section>

          {/* Section 3 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>3. How We Use Information</h2>
            <p>We may use information we collect to:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Provide and operate GrowthSent</li>
              <li>Perform website scans and technical audits</li>
              <li>Provide SEO and website health insights</li>
              <li>Display search and analytics data you authorize us to access</li>
              <li>Provide website monitoring</li>
              <li>Generate reports and recommendations</li>
              <li>Maintain historical analytics and monitoring data</li>
              <li>Improve the Service</li>
              <li>Develop new features</li>
              <li>Detect, prevent, and address security issues</li>
              <li>Prevent abuse and fraudulent activity</li>
              <li>Respond to support requests</li>
              <li>Communicate with you about the Service</li>
              <li>Comply with legal obligations</li>
            </ul>
            <p>We may also use aggregated or de-identified information for analytics, research, and product improvement, provided that such information does not reasonably identify an individual.</p>
          </section>

          {/* Section 4 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>4. How We Share Information</h2>
            <p style={{ fontWeight: 700, color: "#f7f7f3" }}>We do not sell your personal information.</p>
            <p>We may share information in limited circumstances, including with:</p>

            <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "16px 0 8px 0", color: "#f7f7f3" }}>Service Providers</h3>
            <p>We may use trusted third-party service providers to operate GrowthSent, such as providers of:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Cloud infrastructure</li>
              <li>Database hosting</li>
              <li>Authentication</li>
              <li>Analytics</li>
              <li>Error monitoring</li>
              <li>Email delivery</li>
              <li>Payment processing</li>
              <li>Customer support</li>
            </ul>
            <p>These providers may process information only as necessary to provide services to GrowthSent.</p>

            <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "20px 0 8px 0", color: "#f7f7f3" }}>Legal Requirements</h3>
            <p>We may disclose information if required to do so by law, legal process, or valid governmental request, or when we reasonably believe disclosure is necessary to:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Comply with applicable law</li>
              <li>Protect the rights or safety of GrowthSent, our users, or others</li>
              <li>Detect or prevent fraud, abuse, or security threats</li>
            </ul>

            <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "20px 0 8px 0", color: "#f7f7f3" }}>Business Transfers</h3>
            <p>If GrowthSent is involved in a merger, acquisition, financing, reorganization, sale of assets, or similar transaction, information may be transferred as part of that transaction, subject to applicable law.</p>
          </section>

          {/* Section 5 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>5. Public Website Scanning</h2>
            <p>GrowthSent may process publicly accessible website information to provide website health and SEO analysis.</p>
            <p>Publicly accessible information may be temporarily cached or stored to support:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Scan results</li>
              <li>Reports</li>
              <li>Monitoring</li>
              <li>Historical comparisons</li>
              <li>Product functionality</li>
            </ul>
            <p>GrowthSent does not claim ownership of content published on websites that it scans. Website owners remain responsible for the content they publish on their websites.</p>
            <p>If you believe GrowthSent has collected or displayed information that should not be publicly accessible, please contact us using the information provided below.</p>
          </section>

          {/* Section 6 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>6. Data Retention</h2>
            <p>We retain information for as long as reasonably necessary to:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Provide the Service</li>
              <li>Maintain your account</li>
              <li>Provide historical reports and monitoring</li>
              <li>Meet our legal and contractual obligations</li>
              <li>Resolve disputes</li>
              <li>Enforce our agreements</li>
            </ul>
            <p>You may request deletion of your account and associated personal information, subject to legal and operational requirements.</p>
            <p>Some information may remain in backups for a limited period before being permanently deleted or overwritten.</p>
          </section>

          {/* Section 7 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>7. Data Security</h2>
            <p>We take reasonable technical and organizational measures designed to protect information against unauthorized access, loss, misuse, alteration, or disclosure.</p>
            <p>However, no method of electronic transmission or storage is completely secure. We cannot guarantee the absolute security of your information.</p>
            <p>You are responsible for maintaining the security of your account credentials and for notifying us if you believe your account has been compromised.</p>
          </section>

          {/* Section 8 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>8. Your Choices and Rights</h2>
            <p>Depending on your location and applicable law, you may have rights regarding your personal information, including the right to:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Request access to personal information we hold about you</li>
              <li>Request correction of inaccurate information</li>
              <li>Request deletion of personal information</li>
              <li>Request restriction of certain processing</li>
              <li>Object to certain processing</li>
              <li>Request a copy of certain information</li>
              <li>Withdraw consent where processing is based on consent</li>
            </ul>
            <p>You may also disconnect third-party integrations, such as Google Services, at any time.</p>
            <p>To exercise applicable privacy rights, contact us using the information below. We may need to verify your identity before completing certain requests.</p>
          </section>

          {/* Section 9 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>9. Cookies and Similar Technologies</h2>
            <p>GrowthSent may use cookies and similar technologies to:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Keep users signed in</li>
              <li>Maintain authentication sessions</li>
              <li>Remember preferences</li>
              <li>Understand how the Service is used</li>
              <li>Improve performance and reliability</li>
              <li>Detect security issues</li>
            </ul>
            <p>You may be able to control cookies through your browser settings. Disabling certain cookies may affect the functionality of the Service.</p>
          </section>

          {/* Section 10 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>10. Third-Party Services</h2>
            <p>GrowthSent may integrate with or link to third-party services. These services may have their own privacy policies and terms. GrowthSent is not responsible for the privacy practices of third-party services that it does not control.</p>
            <p>Examples may include:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Google Search Console</li>
              <li>Google Analytics</li>
              <li>Authentication providers</li>
              <li>Payment providers</li>
              <li>Cloud infrastructure providers</li>
              <li>Developer tools</li>
              <li>AI services</li>
            </ul>
            <p>We encourage you to review the privacy policies of third-party services before connecting them to GrowthSent.</p>
          </section>

          {/* Section 11 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>11. Children&apos;s Privacy</h2>
            <p>GrowthSent is not intended for children under the age required by applicable law to provide consent to online services.</p>
            <p>We do not knowingly collect personal information from children in violation of applicable law. If you believe a child has provided us with personal information, please contact us so we can take appropriate action.</p>
          </section>

          {/* Section 12 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>12. International Data Transfers</h2>
            <p>GrowthSent may use service providers and infrastructure located in countries other than your own. As a result, your information may be processed or stored outside your country of residence.</p>
            <p>Where required by applicable law, we will take appropriate measures to protect personal information transferred across borders.</p>
          </section>

          {/* Section 13 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>13. Changes to This Privacy Policy</h2>
            <p>We may update this Privacy Policy from time to time. When we make changes, we will update the &quot;Last updated&quot; date at the top of this page.</p>
            <p>If we make material changes, we may provide additional notice where required by applicable law. We encourage you to review this Privacy Policy periodically.</p>
          </section>

          {/* Section 14 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>14. Contact Us</h2>
            <p>If you have questions about this Privacy Policy, your personal information, or GrowthSent&apos;s privacy practices, please contact us:</p>
            <div style={{ marginTop: "12px" }}>
              <strong style={{ color: "#f7f7f3" }}>GrowthSent, Inc.</strong><br />
              Email: <a href="mailto:info@growthsent.com" style={{ color: "#a4ef51", textDecoration: "none" }}>info@growthsent.com</a><br />
              Website: <a href="https://www.growthsent.com" style={{ color: "#a4ef51", textDecoration: "none" }}>https://www.growthsent.com</a>
            </div>
          </section>

          {/* Section 15 */}
          <section style={{ background: "#1f201d", padding: "28px", borderRadius: "14px", border: "1px solid #383a35" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>15. Google API Services User Data</h2>
            <p style={{ fontWeight: 600, color: "#f7f7f3" }}>
              GrowthSent&apos;s use and transfer of information received from Google APIs to any other app of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements.
            </p>
            <ul style={{ paddingLeft: "20px", margin: "12px 0 0 0" }}>
              <li>We only use Google user data to provide and improve features that you explicitly request or authorize.</li>
              <li>We do not sell Google user data.</li>
              <li>We do not use Google user data for advertising.</li>
              <li>We do not transfer Google user data to third parties except as permitted by applicable law and Google&apos;s API Services User Data Policy.</li>
              <li>Where applicable, Google user data is handled in accordance with Google&apos;s Limited Use requirements.</li>
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}
