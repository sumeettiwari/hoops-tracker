import { useState } from "react";
import { supabase } from "./supabase";

export default function Login({ onLogin }) {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    else onLogin();
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0c0f", display: "flex",
      alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0c0f; }
        input { outline: none; }
      `}</style>

      <div style={{
        background: "#111318", border: "1px solid #1e2128", borderRadius: 12,
        padding: "40px 36px", width: "100%", maxWidth: 380,
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🏀</div>
          <div style={{ fontFamily: "'Bebas Neue'", fontSize: 28, letterSpacing: 4, color: "#f97316" }}>
            HOOPS TRACKER
          </div>
          <div style={{ fontFamily: "'DM Sans'", fontSize: 13, color: "#555", marginTop: 4 }}>
            Admin sign in
          </div>
        </div>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontFamily: "'DM Sans'", fontSize: 12, color: "#666", display: "block", marginBottom: 6 }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{
                width: "100%", background: "#0a0c0f", border: "1px solid #2a2d35",
                borderRadius: 4, padding: "10px 14px", color: "#e8e4d9",
                fontFamily: "'DM Sans'", fontSize: 14,
              }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ fontFamily: "'DM Sans'", fontSize: 12, color: "#666", display: "block", marginBottom: 6 }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{
                width: "100%", background: "#0a0c0f", border: "1px solid #2a2d35",
                borderRadius: 4, padding: "10px 14px", color: "#e8e4d9",
                fontFamily: "'DM Sans'", fontSize: 14,
              }}
            />
          </div>

          {error && (
            <div style={{
              fontFamily: "'DM Sans'", fontSize: 13, color: "#fca5a5",
              background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)",
              borderRadius: 4, padding: "8px 12px", marginBottom: 16,
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%", background: "#f97316", color: "#000",
              fontFamily: "'Bebas Neue'", letterSpacing: 2, fontSize: 16,
              padding: "12px", borderRadius: 4, border: "none",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1, transition: "all 0.15s",
            }}
          >
            {loading ? "SIGNING IN..." : "SIGN IN"}
          </button>
        </form>
      </div>
    </div>
  );
}
