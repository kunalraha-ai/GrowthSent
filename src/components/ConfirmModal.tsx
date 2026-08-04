import React from "react";

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "primary";
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  isOpen,
  title,
  message,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(10, 11, 10, 0.75)",
        backdropFilter: "blur(8px)",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: "#171817",
          color: "#f7f7f3",
          width: "100%",
          maxWidth: "440px",
          borderRadius: "16px",
          border: "1px solid #383a35",
          padding: "28px",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.6)",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 800, color: "#f7f7f3" }}>
            {title}
          </h3>
          <button
            onClick={onCancel}
            disabled={loading}
            style={{
              background: "none",
              border: "none",
              color: "#888982",
              fontSize: "20px",
              cursor: "pointer",
              padding: "0 4px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        <div>
          <p style={{ margin: "0 0 8px 0", fontSize: "15px", fontWeight: 600, color: "#f7f7f3" }}>
            {message}
          </p>
          {description && (
            <p style={{ margin: 0, fontSize: "13px", color: "#aaaaa2", lineHeight: 1.5 }}>
              {description}
            </p>
          )}
        </div>

        <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end", marginTop: "8px" }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            style={{
              background: "#2a2c28",
              color: "#f7f7f3",
              border: "1px solid #3d403a",
              padding: "10px 18px",
              borderRadius: "8px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {cancelText}
          </button>

          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            style={{
              background: variant === "danger" ? "#ef4444" : "#a4ef51",
              color: variant === "danger" ? "#ffffff" : "#171817",
              border: "none",
              padding: "10px 18px",
              borderRadius: "8px",
              fontSize: "14px",
              fontWeight: 800,
              cursor: loading ? "wait" : "pointer",
            }}
          >
            {loading ? "Processing..." : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
