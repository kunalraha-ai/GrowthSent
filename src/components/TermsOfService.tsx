import React, { useEffect } from "react";
import { Logo } from "./Logo";

interface TermsOfServiceProps {
  onBack?: () => void;
}

export function TermsOfService({ onBack }: TermsOfServiceProps) {
  useEffect(() => {
    document.title = "Terms of Service — GrowthSent";
  }, []);
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
            LEGAL &amp; TERMS
          </span>
          <h1 style={{ fontSize: "36px", fontWeight: 800, margin: "8px 0 12px 0", color: "#f7f7f3" }}>
            Terms of Service
          </h1>
          <p style={{ color: "#888982", fontSize: "14px", margin: 0 }}>
            Last updated: August 4, 2026
          </p>
        </div>

        <div style={{ fontSize: "15px", lineHeight: "1.7", color: "#d1d2cc", display: "flex", flexDirection: "column", gap: "28px" }}>
          <p style={{ fontSize: "16px", color: "#e4e5e0" }}>
            These Terms of Service govern your access to and use of the GrowthSent website, application, APIs, integrations, and related services provided by GrowthSent.
            By accessing or using the Service, you agree to be bound by these Terms. If you do not agree to these Terms, you may not use the Service.
            If you are using GrowthSent on behalf of a company or organization, you represent that you have authority to bind that organization to these Terms.
          </p>

          {/* Section 1 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>1. The GrowthSent Service</h2>
            <p>GrowthSent provides tools and services designed to help users understand, monitor, and improve the health, discoverability, search performance, and growth of websites.</p>
            <p>Depending on the features available at the time, the Service may include:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Public website scanning</li>
              <li>Technical website and SEO analysis</li>
              <li>Website health checks</li>
              <li>Sitemap and robots.txt analysis</li>
              <li>Search engine visibility insights</li>
              <li>Google Search Console integrations</li>
              <li>Google Analytics integrations</li>
              <li>Website monitoring</li>
              <li>Historical performance analysis</li>
              <li>Keyword and search insights</li>
              <li>Competitor analysis</li>
              <li>Backlink and web intelligence</li>
              <li>APIs</li>
              <li>CLI tools</li>
              <li>Model Context Protocol (MCP) integrations</li>
              <li>Developer tools and integrations</li>
              <li>Reports and recommendations</li>
            </ul>
            <p>GrowthSent may add, modify, suspend, or discontinue features of the Service at any time.</p>
          </section>

          {/* Section 2 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>2. Eligibility</h2>
            <p>You must be legally capable of entering into a binding agreement to use the Service.</p>
            <p>If you are using the Service on behalf of a business, organization, or other entity, you represent and warrant that you have authority to accept these Terms on its behalf.</p>
          </section>

          {/* Section 3 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>3. Accounts</h2>
            <p>Certain features may require you to create an account.</p>
            <p>You agree to:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Provide accurate information</li>
              <li>Keep your account information current</li>
              <li>Maintain the security of your account credentials</li>
              <li>Keep your authentication credentials confidential</li>
              <li>Notify us promptly if you believe your account has been compromised</li>
            </ul>
            <p>You are responsible for activity that occurs through your account unless caused by GrowthSent&apos;s failure to maintain reasonable security measures.</p>
            <p>GrowthSent reserves the right to suspend or terminate accounts that violate these Terms or pose a security or abuse risk.</p>
          </section>

          {/* Section 4 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>4. Website Scanning</h2>
            <p>GrowthSent allows users to submit website URLs for analysis.</p>
            <p>You represent and warrant that:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>You have the right or authorization to request analysis of websites you submit where authorization is required</li>
              <li>Your use of the Service does not violate applicable law</li>
              <li>You will not use the Service to conduct unauthorized or abusive scanning</li>
              <li>You will not intentionally attempt to overload, disrupt, or damage websites or infrastructure</li>
            </ul>
            <p>GrowthSent may access publicly available website information, including pages, links, metadata, robots.txt files, sitemaps, and other publicly accessible resources, to perform requested analyses.</p>
            <p>GrowthSent does not guarantee that every website can be successfully scanned or analyzed.</p>
            <p>Website owners may configure their websites to restrict or prevent automated access. GrowthSent may respect applicable technical restrictions, including robots.txt directives, where appropriate.</p>
          </section>

          {/* Section 5 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>5. Third-Party Integrations</h2>
            <p>GrowthSent may allow you to connect third-party services, including Google Search Console and Google Analytics.</p>
            <p>When you connect a third-party service, you authorize GrowthSent to access information permitted by the permissions you grant.</p>
            <p>Your use of third-party services remains subject to the applicable third party&apos;s terms and policies.</p>
            <p>GrowthSent is not responsible for:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Changes to third-party APIs</li>
              <li>Third-party service outages</li>
              <li>Changes to third-party data availability</li>
              <li>Third-party service limitations</li>
              <li>Errors or inaccuracies originating from third-party services</li>
            </ul>
            <p>You may disconnect third-party integrations at any time.</p>
            <p>GrowthSent may discontinue support for a third-party integration if the provider changes or removes the relevant API or functionality.</p>
          </section>

          {/* Section 6 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>6. Data and User Content</h2>
            <p>You retain ownership of content and information that you submit to GrowthSent or provide through your use of the Service, except for rights expressly granted to GrowthSent under these Terms.</p>
            <p>You grant GrowthSent a limited, non-exclusive, worldwide license to host, process, reproduce, modify, transmit, and display your submitted information solely as necessary to:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Provide the Service</li>
              <li>Perform requested analyses</li>
              <li>Generate reports</li>
              <li>Provide monitoring</li>
              <li>Maintain and improve the Service</li>
              <li>Provide customer support</li>
              <li>Maintain security and prevent abuse</li>
            </ul>
            <p>This license ends when the relevant information is deleted, except where retention is reasonably necessary for legal, security, backup, or legitimate operational purposes.</p>
            <p>You are responsible for ensuring that you have the necessary rights and permissions to submit information to GrowthSent.</p>
          </section>

          {/* Section 7 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>7. Publicly Available Data</h2>
            <p>GrowthSent may process publicly accessible information obtained from websites and other publicly available sources.</p>
            <p>GrowthSent does not claim ownership of content published by third parties.</p>
            <p>GrowthSent may transform, analyze, aggregate, index, or derive insights from publicly available information in order to provide features of the Service, subject to applicable law and third-party terms.</p>
            <p>You agree not to use GrowthSent to violate the rights of website owners, content creators, or other third parties.</p>
          </section>

          {/* Section 8 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>8. Reports and Recommendations</h2>
            <p>GrowthSent may provide reports, recommendations, insights, scores, suggestions, or other forms of analysis. These outputs are provided for informational purposes only.</p>
            <p>GrowthSent does not guarantee that:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Recommendations will improve search rankings</li>
              <li>Recommendations will increase traffic</li>
              <li>Recommendations will increase conversions</li>
              <li>Search engines will index or rank a website</li>
              <li>A website will appear in search results</li>
              <li>A website will appear in AI-generated answers</li>
              <li>Implementing a recommendation will produce a particular business outcome</li>
            </ul>
            <p>Search engines, analytics providers, AI systems, and other third parties may change their algorithms, policies, ranking systems, APIs, and data availability at any time.</p>
            <p>You are responsible for deciding whether and how to implement recommendations provided by GrowthSent.</p>
          </section>

          {/* Section 9 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>9. AI and Automated Features</h2>
            <p>GrowthSent may provide AI-assisted features, automated recommendations, code suggestions, or integrations with developer tools and AI agents.</p>
            <p>AI-generated outputs may be inaccurate, incomplete, outdated, or unsuitable for your particular situation.</p>
            <p>You are responsible for reviewing and validating AI-generated or automated outputs before using them.</p>
            <p>GrowthSent does not guarantee that AI-generated suggestions or automated actions will be error-free.</p>
            <p>If GrowthSent provides tools capable of modifying code, creating pull requests, or interacting with external systems, you are responsible for reviewing and approving actions before deployment unless you intentionally configure an automated workflow.</p>
            <p>You should maintain appropriate backups and version control when using automated development features.</p>
          </section>

          {/* Section 10 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>10. APIs, CLI, MCP, and Developer Tools</h2>
            <p>GrowthSent may provide APIs, command-line tools, MCP servers, SDKs, or other developer interfaces.</p>
            <p>Your use of these tools may be subject to additional documentation, technical restrictions, rate limits, or usage policies.</p>
            <p>You agree not to:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Circumvent rate limits</li>
              <li>Abuse API access</li>
              <li>Attempt unauthorized access</li>
              <li>Reverse engineer authentication mechanisms</li>
              <li>Use the Service to attack or disrupt third-party systems</li>
              <li>Use API access to create a competing service in violation of applicable license terms</li>
              <li>Misrepresent GrowthSent&apos;s services or identity</li>
            </ul>
            <p>GrowthSent may impose rate limits or suspend API access to protect the Service and its users.</p>
          </section>

          {/* Section 11 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>11. Open Source and Open-Core Software</h2>
            <p>Certain GrowthSent components may be released under open-source or source-available licenses.</p>
            <p>Those components are governed by the applicable license accompanying the relevant software.</p>
            <p>If there is a conflict between these Terms and a separate software license governing a particular GrowthSent component, the applicable software license will govern that component to the extent of the conflict.</p>
            <p>Your use of GrowthSent&apos;s hosted Service does not grant you ownership of proprietary hosted infrastructure, proprietary datasets, or features that are not distributed under an applicable open-source or source-available license.</p>
          </section>

          {/* Section 12 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>12. Acceptable Use</h2>
            <p>You agree not to use the Service to:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Violate applicable laws or regulations</li>
              <li>Infringe intellectual property or privacy rights</li>
              <li>Conduct unauthorized security testing</li>
              <li>Attack or disrupt websites or infrastructure</li>
              <li>Perform denial-of-service attacks</li>
              <li>Circumvent authentication or access controls</li>
              <li>Attempt to gain unauthorized access to accounts or systems</li>
              <li>Upload malicious software</li>
              <li>Distribute malware</li>
              <li>Abuse APIs or infrastructure</li>
              <li>Scrape GrowthSent in a manner that imposes unreasonable load</li>
              <li>Circumvent usage limits</li>
              <li>Interfere with the operation of the Service</li>
              <li>Use the Service to facilitate unlawful activity</li>
              <li>Impersonate GrowthSent or another person or organization</li>
            </ul>
            <p>GrowthSent may suspend or terminate access if we reasonably believe that your use violates these Terms or threatens the security or availability of the Service.</p>
          </section>

          {/* Section 13 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>13. Intellectual Property</h2>
            <p>The GrowthSent Service, including its software, branding, designs, interfaces, documentation, trademarks, logos, and original content, is owned by or licensed to GrowthSent and protected by applicable intellectual property laws.</p>
            <p>Except as expressly permitted by these Terms or an applicable open-source license, you may not:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Copy or reproduce the Service</li>
              <li>Modify or create derivative works from proprietary portions of the Service</li>
              <li>Redistribute proprietary components</li>
              <li>Sell or sublicense proprietary components</li>
              <li>Reverse engineer the Service except where permitted by applicable law</li>
              <li>Remove proprietary notices or branding</li>
            </ul>
            <p>Nothing in these Terms transfers ownership of GrowthSent&apos;s intellectual property to you.</p>
          </section>

          {/* Section 14 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>14. Feedback</h2>
            <p>If you provide suggestions, ideas, feature requests, or other feedback about GrowthSent, you grant GrowthSent the right to use that feedback without restriction or compensation to you.</p>
            <p>You retain ownership of any intellectual property rights you may have in your feedback.</p>
          </section>

          {/* Section 15 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>15. Fees and Payments</h2>
            <p>Certain features of GrowthSent may require payment.</p>
            <p>If you purchase a paid plan:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>You agree to pay the applicable fees</li>
              <li>You authorize GrowthSent or its payment provider to charge the applicable payment method</li>
              <li>Fees may vary depending on the selected plan or usage</li>
              <li>Usage-based charges may apply where clearly disclosed</li>
            </ul>
            <p>Prices and plan features may change from time to time. If pricing changes affect an existing paid subscription, GrowthSent will provide notice where required by applicable law.</p>
            <p>Failure to pay applicable fees may result in suspension or termination of paid features.</p>
          </section>

          {/* Section 16 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>16. Free Services and Trials</h2>
            <p>GrowthSent may offer free services, free plans, trials, promotional offers, or limited-access features.</p>
            <p>Free services are provided without any guarantee of continued availability. GrowthSent may modify or discontinue free features at any time.</p>
            <p>Unless otherwise stated, free services do not create any obligation for GrowthSent to provide ongoing access.</p>
          </section>

          {/* Section 17 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>17. Cancellation and Termination</h2>
            <p>You may stop using GrowthSent at any time. You may also request deletion of your account, subject to applicable legal and operational requirements.</p>
            <p>GrowthSent may suspend or terminate your access if:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>You violate these Terms</li>
              <li>You engage in abusive or fraudulent activity</li>
              <li>Your use creates a security risk</li>
              <li>Your use creates unreasonable operational risk</li>
              <li>Required by law</li>
              <li>The Service is discontinued</li>
            </ul>
            <p>Upon termination, your right to use the Service will end.</p>
            <p>Certain provisions of these Terms will survive termination, including provisions relating to intellectual property, disclaimers, limitations of liability, indemnification, and dispute resolution.</p>
          </section>

          {/* Section 18 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>18. Service Availability</h2>
            <p>GrowthSent is provided on an evolving basis. We do not guarantee that the Service will:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Always be available</li>
              <li>Be uninterrupted</li>
              <li>Be error-free</li>
              <li>Be secure against every possible threat</li>
              <li>Work with every website</li>
              <li>Work with every browser or device</li>
              <li>Maintain compatibility with every third-party service</li>
            </ul>
            <p>We may perform maintenance, upgrades, or changes that temporarily affect availability.</p>
          </section>

          {/* Section 19 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>19. Disclaimer of Warranties</h2>
            <p>To the maximum extent permitted by applicable law, the Service is provided on an &quot;AS IS&quot; and &quot;AS AVAILABLE&quot; basis.</p>
            <p>GrowthSent disclaims all warranties, express or implied, including warranties of:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Merchantability</li>
              <li>Fitness for a particular purpose</li>
              <li>Non-infringement</li>
              <li>Accuracy</li>
              <li>Reliability</li>
              <li>Availability</li>
            </ul>
            <p>GrowthSent does not guarantee any particular search engine ranking, website traffic, revenue, conversion rate, or business result.</p>
            <p>You use the Service at your own risk.</p>
          </section>

          {/* Section 20 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>20. Limitation of Liability</h2>
            <p>To the maximum extent permitted by applicable law, GrowthSent and its officers, directors, employees, contractors, affiliates, and service providers will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, including loss of:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Profits</li>
              <li>Revenue</li>
              <li>Data</li>
              <li>Business opportunities</li>
              <li>Goodwill</li>
              <li>Business interruption</li>
            </ul>
            <p>arising from or related to your use of or inability to use the Service.</p>
            <p>To the maximum extent permitted by applicable law, GrowthSent&apos;s total aggregate liability arising from or related to the Service will not exceed the greater of:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>The amount you paid to GrowthSent for the Service during the twelve months preceding the event giving rise to the claim; or</li>
              <li>One hundred U.S. dollars (US $100).</li>
            </ul>
            <p>Nothing in these Terms limits liability that cannot legally be limited under applicable law.</p>
          </section>

          {/* Section 21 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>21. Indemnification</h2>
            <p>To the maximum extent permitted by applicable law, you agree to defend, indemnify, and hold harmless GrowthSent and its officers, directors, employees, contractors, affiliates, and service providers from claims, damages, liabilities, losses, and expenses arising from:</p>
            <ul style={{ paddingLeft: "20px", margin: "8px 0" }}>
              <li>Your use of the Service</li>
              <li>Your violation of these Terms</li>
              <li>Your violation of applicable law</li>
              <li>Your violation of third-party rights</li>
              <li>Content or information you submit to the Service</li>
              <li>Your unauthorized use of websites or third-party services</li>
            </ul>
          </section>

          {/* Section 22 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>22. Third-Party Services and Links</h2>
            <p>GrowthSent may contain links to or integrations with third-party services. GrowthSent does not control and is not responsible for third-party services, content, availability, security, or policies.</p>
            <p>Your use of third-party services is governed by their respective terms and policies.</p>
          </section>

          {/* Section 23 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>23. Changes to These Terms</h2>
            <p>We may update these Terms from time to time. When we make changes, we will update the &quot;Last updated&quot; date at the top of this page.</p>
            <p>If we make material changes, we may provide additional notice where required by applicable law.</p>
            <p>Your continued use of GrowthSent after updated Terms become effective constitutes acceptance of the revised Terms, to the extent permitted by applicable law.</p>
          </section>

          {/* Section 24 */}
          <section style={{ background: "#1f201d", padding: "28px", borderRadius: "14px", border: "1px solid #383a35" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>24. Governing Law</h2>
            <p>These Terms are governed by and construed in accordance with the laws of India.</p>
            <p>Subject to applicable law, any disputes arising out of or relating to these Terms or your use of the Service will be subject to the jurisdiction of the courts of Pune, Maharashtra, India.</p>
          </section>

          {/* Section 25 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>25. Severability</h2>
            <p>If any provision of these Terms is determined to be invalid or unenforceable, the remaining provisions will remain in full force and effect.</p>
          </section>

          {/* Section 26 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>26. Entire Agreement</h2>
            <p>These Terms, together with the GrowthSent Privacy Policy and any additional terms applicable to specific features, constitute the entire agreement between you and GrowthSent regarding your use of the Service.</p>
          </section>

          {/* Section 27 */}
          <section style={{ background: "#171817", padding: "28px", borderRadius: "14px", border: "1px solid #282a26" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 16px 0", color: "#a4ef51" }}>27. Contact Us</h2>
            <p>If you have questions about these Terms or the GrowthSent Service, please contact us:</p>
            <div style={{ marginTop: "12px" }}>
              <strong style={{ color: "#f7f7f3" }}>GrowthSent</strong><br />
              Email: <a href="mailto:info@growthsent.com" style={{ color: "#a4ef51", textDecoration: "none" }}>info@growthsent.com</a><br />
              Website: <a href="https://www.growthsent.com" style={{ color: "#a4ef51", textDecoration: "none" }}>https://www.growthsent.com</a>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
