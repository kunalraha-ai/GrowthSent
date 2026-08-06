import React, { useEffect, useState } from "react";
import { Logo } from "./Logo";

interface PricingPageProps {
  onBack?: () => void;
  onGetStarted?: () => void;
  onContactSales?: () => void;
}

export function PricingPage({ onBack, onGetStarted, onContactSales }: PricingPageProps) {
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(0);

  useEffect(() => {
    document.title = "Pricing — GrowthSent";
  }, []);

  const toggleFaq = (index: number) => {
    setOpenFaqIndex(openFaqIndex === index ? null : index);
  };

  const faqs = [
    {
      q: "Can I use GrowthSent for free?",
      a: "Yes! The Hobby plan is 100% free forever for early-stage products, solo builders, and personal projects. No credit card required to get started.",
    },
    {
      q: "Can I upgrade anytime?",
      a: "Absolutely. You can upgrade, downgrade, or switch plans at any time directly from your account console. Changes take effect immediately.",
    },
    {
      q: "What happens if I exceed my limits?",
      a: "We never hard-block your service mid-month. If you approach your plan limits, we'll notify you so you can seamlessly upgrade to the next tier or adjust your crawl scope.",
    },
    {
      q: "Do all plans include API and MCP access?",
      a: "Yes! Every plan—including the free Hobby tier—includes full REST API access and Model Context Protocol (MCP) integration for Cursor, Claude Code, and custom AI developer agents.",
    },
    {
      q: "Can I cancel anytime?",
      a: "Yes, you can cancel your paid subscription at any time with a single click in your dashboard settings. There are no contracts, commitments, or hidden cancellation fees.",
    },
  ];

  const tableData = [
    { feature: "Projects", hobby: "1", growth: "Unlimited", team: "Unlimited", enterprise: "Unlimited" },
    { feature: "Team Members", hobby: "1", growth: "1", team: "Unlimited", enterprise: "Unlimited" },
    { feature: "Website Crawl", hobby: "Up to 100 pages", growth: "Up to 10,000 pages", team: "Up to 100,000 pages", enterprise: "Custom" },
    { feature: "GSC & GA4 Properties", hobby: "1 Property", growth: "Unlimited", team: "Unlimited", enterprise: "Unlimited" },
    { feature: "Technical SEO Audit", hobby: "✅", growth: "✅", team: "✅", enterprise: "✅" },
    { feature: "Sitemap / Robots / Canonicals / Redirects / Broken Links", hobby: "✅", growth: "✅", team: "✅", enterprise: "✅" },
    { feature: "Core Web Vitals", hobby: "Basic", growth: "Full", team: "Full", enterprise: "Full" },
    { feature: "Historical Data", hobby: "30 Days", growth: "Unlimited", team: "Unlimited", enterprise: "Unlimited" },
    { feature: "Referring Domains / Backlinks", hobby: "Top 25 / Top 100", growth: "Unlimited", team: "Unlimited", enterprise: "Unlimited" },
    { feature: "Competitor Analysis", hobby: "1", growth: "20", team: "Unlimited", enterprise: "Unlimited" },
    { feature: "API & MCP", hobby: "✅", growth: "✅", team: "✅", enterprise: "✅" },
    { feature: "Monthly Compute Credits", hobby: "Included", growth: "Higher Included Usage", team: "Highest Included Usage", enterprise: "Custom" },
    { feature: "CSV Export", hobby: "✅", growth: "✅", team: "✅", enterprise: "✅" },
    { feature: "JSON Export", hobby: "❌", growth: "✅", team: "✅", enterprise: "✅" },
    { feature: "White-label Reports", hobby: "❌", growth: "❌", team: "✅", enterprise: "✅" },
    { feature: "Roles & Permissions", hobby: "❌", growth: "❌", team: "✅", enterprise: "✅" },
    { feature: "Priority Queue", hobby: "❌", growth: "✅", team: "✅", enterprise: "Dedicated" },
    { feature: "Support", hobby: "Community", growth: "Email", team: "Priority", enterprise: "Dedicated SLA" },
  ];

  return (
    <div style={{ background: "#0e0f0e", color: "#f7f7f3", minHeight: "100vh", fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Header Navigation */}
      <header style={{
        borderBottom: "1px solid #232521",
        padding: "18px 32px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        maxWidth: "1200px",
        margin: "0 auto",
      }}>
        <div style={{ cursor: "pointer" }} onClick={onBack}>
          <Logo dark />
        </div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          {onBack && (
            <button
              onClick={onBack}
              style={{
                background: "transparent",
                color: "#888982",
                border: "none",
                fontSize: "14px",
                cursor: "pointer",
                marginRight: "8px",
              }}
            >
              ← Back to Home
            </button>
          )}
          <button
            onClick={onGetStarted}
            style={{
              background: "#a4ef51",
              color: "#0e0f0e",
              border: "none",
              padding: "9px 18px",
              borderRadius: "8px",
              fontSize: "14px",
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Get Started
          </button>
        </div>
      </header>

      {/* Main Container */}
      <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "60px 24px 100px" }}>

        {/* Hero Section */}
        <div style={{ textAlign: "center", marginBottom: "64px" }}>
          <div style={{
            display: "inline-block",
            padding: "5px 14px",
            borderRadius: "20px",
            background: "#171817",
            border: "1px solid #2d2f2b",
            color: "#a4ef51",
            fontSize: "12px",
            fontWeight: 800,
            letterSpacing: "1px",
            marginBottom: "20px",
            textTransform: "uppercase"
          }}>
            PRICING
          </div>
          <h1 style={{ fontSize: "52px", fontWeight: 900, letterSpacing: "-1.5px", margin: "0 0 16px 0", color: "#f7f7f3" }}>
            Simple pricing
          </h1>
          <p style={{ fontSize: "20px", color: "#a5a69f", margin: "0 0 8px 0", fontWeight: 500 }}>
            One platform to optimize, monitor and grow your website.
          </p>
          <p style={{ fontSize: "15px", color: "#71736b", margin: 0, fontWeight: 600 }}>
            Free forever for early-stage products.
          </p>
        </div>

        {/* Pricing Cards Grid */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "24px",
          alignItems: "stretch",
          marginBottom: "100px",
        }}>

          {/* 1. Hobby */}
          <div style={{
            background: "#141513",
            border: "1px solid #262824",
            borderRadius: "16px",
            padding: "32px 24px",
            display: "flex",
            flexDirection: "column",
            position: "relative",
            transition: "transform 0.2s ease, border-color 0.2s ease",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <span style={{ fontSize: "16px" }}>🟢</span>
              <h3 style={{ fontSize: "20px", fontWeight: 800, margin: 0 }}>Hobby</h3>
            </div>
            <div style={{ margin: "16px 0 24px" }}>
              <span style={{ fontSize: "42px", fontWeight: 900, color: "#f7f7f3" }}>Free</span>
            </div>
            <button
              onClick={onGetStarted}
              style={{
                width: "100%",
                background: "#232521",
                color: "#f7f7f3",
                border: "1px solid #383a35",
                padding: "12px",
                borderRadius: "10px",
                fontSize: "14px",
                fontWeight: 700,
                cursor: "pointer",
                marginBottom: "28px",
                transition: "all 0.15s ease",
              }}
            >
              Get Started
            </button>
            <div style={{ borderTop: "1px solid #232521", paddingTop: "24px", flex: 1 }}>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "12px", fontSize: "13.5px", color: "#a5a69f" }}>
                <li>✓ 1 Project</li>
                <li>✓ 1 Team Member</li>
                <li>✓ Crawl up to 100 pages</li>
                <li>✓ 1 Google Search Console property</li>
                <li>✓ 1 Google Analytics property</li>
                <li>✓ Technical SEO Audit</li>
                <li>✓ Sitemap, Robots, Canonicals, Redirects & Broken Link checks</li>
                <li>✓ Basic Core Web Vitals</li>
                <li>✓ 30 Days History</li>
                <li>✓ Top 25 Referring Domains</li>
                <li>✓ Top 100 Backlinks</li>
                <li>✓ 1 Competitor</li>
                <li>✓ API Access</li>
                <li>✓ MCP Access</li>
                <li>✓ Included Compute Credits</li>
                <li>✓ CSV Export</li>
              </ul>
            </div>
          </div>

          {/* 2. Growth (Most Popular) */}
          <div style={{
            background: "#161815",
            border: "2px solid #a4ef51",
            borderRadius: "16px",
            padding: "32px 24px",
            display: "flex",
            flexDirection: "column",
            position: "relative",
            boxShadow: "0 0 30px rgba(164, 239, 81, 0.08)",
          }}>
            <div style={{
              position: "absolute",
              top: "-14px",
              left: "50%",
              transform: "translateX(-50%)",
              background: "#a4ef51",
              color: "#0e0f0e",
              padding: "4px 14px",
              borderRadius: "20px",
              fontSize: "11px",
              fontWeight: 900,
              letterSpacing: "0.8px",
              textTransform: "uppercase",
            }}>
              Most Popular
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <span style={{ fontSize: "16px" }}>🔵</span>
              <h3 style={{ fontSize: "20px", fontWeight: 800, margin: 0 }}>Growth</h3>
            </div>
            <div style={{ margin: "16px 0 24px" }}>
              <span style={{ fontSize: "42px", fontWeight: 900, color: "#f7f7f3" }}>$19</span>
              <span style={{ color: "#888982", fontSize: "14px", fontWeight: 500 }}> /month</span>
            </div>
            <button
              onClick={onGetStarted}
              style={{
                width: "100%",
                background: "#a4ef51",
                color: "#0e0f0e",
                border: "none",
                padding: "12px",
                borderRadius: "10px",
                fontSize: "14px",
                fontWeight: 800,
                cursor: "pointer",
                marginBottom: "28px",
                transition: "all 0.15s ease",
              }}
            >
              Upgrade
            </button>
            <div style={{ borderTop: "1px solid #262824", paddingTop: "24px", flex: 1 }}>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "12px", fontSize: "13.5px", color: "#d4d4ce" }}>
                <li>✓ Unlimited Projects</li>
                <li>✓ Crawl up to 10,000 pages</li>
                <li>✓ Unlimited GSC & GA4</li>
                <li>✓ Full Technical SEO</li>
                <li>✓ Full Core Web Vitals</li>
                <li>✓ Unlimited History</li>
                <li>✓ Unlimited Referring Domains</li>
                <li>✓ Unlimited Backlinks</li>
                <li>✓ 20 Competitors</li>
                <li>✓ API</li>
                <li>✓ MCP</li>
                <li>✓ Higher Included Compute Credits</li>
                <li>✓ CSV Export</li>
                <li>✓ JSON Export</li>
                <li>✓ Priority Queue</li>
                <li>✓ Email Support</li>
              </ul>
            </div>
          </div>

          {/* 3. Team */}
          <div style={{
            background: "#141513",
            border: "1px solid #262824",
            borderRadius: "16px",
            padding: "32px 24px",
            display: "flex",
            flexDirection: "column",
            position: "relative",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <span style={{ fontSize: "16px" }}>🟣</span>
              <h3 style={{ fontSize: "20px", fontWeight: 800, margin: 0 }}>Team</h3>
            </div>
            <div style={{ margin: "16px 0 24px" }}>
              <span style={{ fontSize: "42px", fontWeight: 900, color: "#f7f7f3" }}>$79</span>
              <span style={{ color: "#888982", fontSize: "14px", fontWeight: 500 }}> /month</span>
            </div>
            <button
              onClick={onGetStarted}
              style={{
                width: "100%",
                background: "#232521",
                color: "#f7f7f3",
                border: "1px solid #383a35",
                padding: "12px",
                borderRadius: "10px",
                fontSize: "14px",
                fontWeight: 700,
                cursor: "pointer",
                marginBottom: "28px",
              }}
            >
              Upgrade
            </button>
            <div style={{ borderTop: "1px solid #232521", paddingTop: "24px", flex: 1 }}>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "12px", fontSize: "13.5px", color: "#a5a69f" }}>
                <li>✓ Unlimited Projects</li>
                <li>✓ Unlimited Team Members</li>
                <li>✓ Crawl up to 100,000 pages</li>
                <li>✓ Unlimited Everything</li>
                <li>✓ White-label Reports</li>
                <li>✓ Roles & Permissions</li>
                <li>✓ Highest Included Compute Credits</li>
                <li>✓ Priority Queue</li>
                <li>✓ Priority Support</li>
              </ul>
            </div>
          </div>

          {/* 4. Enterprise */}
          <div style={{
            background: "#141513",
            border: "1px solid #262824",
            borderRadius: "16px",
            padding: "32px 24px",
            display: "flex",
            flexDirection: "column",
            position: "relative",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
              <span style={{ fontSize: "16px" }}>🏢</span>
              <h3 style={{ fontSize: "20px", fontWeight: 800, margin: 0 }}>Enterprise</h3>
            </div>
            <div style={{ margin: "16px 0 24px" }}>
              <span style={{ fontSize: "42px", fontWeight: 900, color: "#f7f7f3" }}>Custom</span>
            </div>
            <button
              onClick={onContactSales}
              style={{
                width: "100%",
                background: "#232521",
                color: "#f7f7f3",
                border: "1px solid #383a35",
                padding: "12px",
                borderRadius: "10px",
                fontSize: "14px",
                fontWeight: 700,
                cursor: "pointer",
                marginBottom: "28px",
              }}
            >
              Contact Sales
            </button>
            <div style={{ borderTop: "1px solid #232521", paddingTop: "24px", flex: 1 }}>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "12px", fontSize: "13.5px", color: "#a5a69f" }}>
                <li>✓ Custom Limits</li>
                <li>✓ Dedicated Infrastructure</li>
                <li>✓ Dedicated SLA</li>
                <li>✓ Dedicated Support</li>
                <li>✓ Custom Compute</li>
                <li>✓ Everything Included</li>
              </ul>
            </div>
          </div>

        </div>

        {/* Feature Comparison Table */}
        <div style={{ marginBottom: "12px" }}>
          <h2 style={{ fontSize: "32px", fontWeight: 900, textAlign: "center", marginBottom: "12px" }}>
            Compare Plans &amp; Features
          </h2>
          <p style={{ textAlign: "center", color: "#888982", fontSize: "16px", marginBottom: "40px" }}>
            Detailed breakdown of what&apos;s included in every GrowthSent tier.
          </p>

          <div style={{ overflowX: "auto", border: "1px solid #232521", borderRadius: "16px", background: "#121311" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "14px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #232521", background: "#171816" }}>
                  <th style={{ padding: "18px 24px", fontWeight: 800, color: "#f7f7f3", minWidth: "240px" }}>Feature</th>
                  <th style={{ padding: "18px 20px", fontWeight: 800, color: "#a4ef51", textAlign: "center" }}>Hobby</th>
                  <th style={{ padding: "18px 20px", fontWeight: 800, color: "#60a5fa", textAlign: "center" }}>Growth</th>
                  <th style={{ padding: "18px 20px", fontWeight: 800, color: "#c084fc", textAlign: "center" }}>Team</th>
                  <th style={{ padding: "18px 20px", fontWeight: 800, color: "#f7f7f3", textAlign: "center" }}>Enterprise</th>
                </tr>
              </thead>
              <tbody>
                {tableData.map((row, idx) => (
                  <tr key={row.feature} style={{ borderBottom: idx === tableData.length - 1 ? "none" : "1px solid #1e201c" }}>
                    <td style={{ padding: "16px 24px", color: "#e4e4e0", fontWeight: 600 }}>{row.feature}</td>
                    <td style={{ padding: "16px 20px", textAlign: "center", color: "#a5a69f" }}>{row.hobby}</td>
                    <td style={{ padding: "16px 20px", textAlign: "center", color: "#e4e4e0", fontWeight: 600 }}>{row.growth}</td>
                    <td style={{ padding: "16px 20px", textAlign: "center", color: "#a5a69f" }}>{row.team}</td>
                    <td style={{ padding: "16px 20px", textAlign: "center", color: "#a5a69f" }}>{row.enterprise}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* FAQ Section */}
        <div style={{ marginTop: "100px", maxWidth: "800px", margin: "100px auto 0" }}>
          <h2 style={{ fontSize: "32px", fontWeight: 900, textAlign: "center", marginBottom: "12px" }}>
            Frequently Asked Questions
          </h2>
          <p style={{ textAlign: "center", color: "#888982", fontSize: "16px", marginBottom: "40px" }}>
            Everything you need to know about GrowthSent plans and pricing.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {faqs.map((faq, index) => {
              const isOpen = openFaqIndex === index;
              return (
                <div
                  key={faq.q}
                  style={{
                    background: "#141513",
                    border: "1px solid #232521",
                    borderRadius: "12px",
                    overflow: "hidden",
                    transition: "border-color 0.15s ease",
                  }}
                >
                  <button
                    onClick={() => toggleFaq(index)}
                    style={{
                      width: "100%",
                      padding: "20px 24px",
                      background: "transparent",
                      border: "none",
                      color: "#f7f7f3",
                      fontSize: "16px",
                      fontWeight: 700,
                      textAlign: "left",
                      cursor: "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span>{faq.q}</span>
                    <span style={{ fontSize: "18px", color: "#a4ef51", marginLeft: "16px" }}>
                      {isOpen ? "−" : "+"}
                    </span>
                  </button>
                  {isOpen && (
                    <div style={{ padding: "0 24px 20px 24px", color: "#a5a69f", fontSize: "14.5px", lineHeight: "1.6" }}>
                      {faq.a}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Bottom CTA Section */}
        <div style={{
          marginTop: "120px",
          background: "linear-gradient(180deg, #171916 0%, #111210 100%)",
          border: "1px solid #282a25",
          borderRadius: "24px",
          padding: "60px 32px",
          textAlign: "center",
        }}>
          <h2 style={{ fontSize: "40px", fontWeight: 900, margin: "0 0 16px 0", color: "#f7f7f3", letterSpacing: "-1px" }}>
            Ready to grow your website?
          </h2>
          <p style={{ color: "#888982", fontSize: "17px", maxWidth: "520px", margin: "0 auto 36px auto", lineHeight: "1.6" }}>
            Start auditing, optimizing, and monitoring your website in seconds. No credit card required.
          </p>
          <div style={{ display: "flex", gap: "16px", justifyContent: "center", flexWrap: "wrap" }}>
            <button
              onClick={onGetStarted}
              style={{
                background: "#a4ef51",
                color: "#0e0f0e",
                border: "none",
                padding: "14px 28px",
                borderRadius: "10px",
                fontSize: "15px",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Get Started Free →
            </button>
            <button
              onClick={onContactSales}
              style={{
                background: "#1f201d",
                color: "#f7f7f3",
                border: "1px solid #383a35",
                padding: "14px 28px",
                borderRadius: "10px",
                fontSize: "15px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Contact Sales
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
