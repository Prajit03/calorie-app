import { useState, useRef, useEffect } from "react";

// ── Gemini API ────────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";

async function askGPT({ apiKey, systemPrompt, userText, imageBase64 }) {
  const parts = [];

  if (userText) {
    parts.push({ text: userText });
  }

  if (imageBase64) {
    parts.push({
      inline_data: {
        mime_type: "image/jpeg",
        data: imageBase64,
      },
    });
  }

  if (parts.length === 0) {
    parts.push({ text: "Hello" });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts,
          },
        ],
        generationConfig: {
          maxOutputTokens: 500,
          temperature: 0.4,
        },
      }),
    }
  );

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || "Gemini request failed.";
    throw new Error(msg);
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim() || "No response.";

  return text;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const todayKey = () => new Date().toISOString().slice(0, 10);

function projectGoalDate(current, goal, weeklyLoss = 0.7) {
  if (!current || !goal || current <= goal) return null;
  const d = new Date();
  d.setDate(d.getDate() + Math.round(((current - goal) / weeklyLoss) * 7));
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const LS = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  remove: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
  getObj: (k) => {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  setObj: (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

// ── Default profile ───────────────────────────────────────────────────────────
const DEFAULT_PROFILE = {
  name: "",
  currentWeight: "",
  goalWeight: "",
  calTarget: 1500,
  proteinTarget: 110,
};

// ── System prompts ────────────────────────────────────────────────────────────
function buildSystemPrompt(profile, todayData, mode) {
  const calLeft = profile.calTarget - todayData.cals;
  const protLeft = profile.proteinTarget - todayData.protein;

  const base = `You are a macro-tracking assistant inside a mobile app. You're sharp, direct, and occasionally dry/witty — like a smart mate who actually knows nutrition, not a wellness influencer.

USER PROFILE:
- Name: ${profile.name || "User"} | ${profile.currentWeight}kg → ${profile.goalWeight}kg goal
- Daily targets: ${profile.calTarget} kcal / ${profile.proteinTarget}g protein
- Logged today: ${todayData.cals} kcal / ${todayData.protein}g protein
- Remaining: ${calLeft} kcal / ${protLeft}g protein

RULES:
- Keep responses SHORT. Max 2 sentences before any JSON.
- No emojis in text. No filler like "Great choice!" or "Sure thing!".
- Be accurate. When uncertain about portions, ASK — never guess and silently log.
- Tone: knowledgeable mate texting back, not an app notification.`;

  if (mode === "image_scan") {
    return (
      base + `

IMAGE ANALYSIS MODE:
You are analysing a food photo with a multimodal model.
1. Identify every food item with specificity — "~180g basmati rice" not "some rice".
2. Estimate portions from visual cues: plate diameter, food density, typical serving sizes, visible depth.
3. Ask ONE short, specific confirmation question about the biggest uncertainty (usually portion weight or cooking method).
4. Do NOT log yet — end your response with exactly: PENDING_CONFIRMATION

Example: "Looks like grilled paneer with basmati rice and a tomato-based curry. Is that roughly 150g of paneer or closer to 100g?" PENDING_CONFIRMATION`
    );
  }

  if (mode === "confirm_log") {
    return (
      base + `

CONFIRMATION MODE:
The user has confirmed portion details. Re-check the original image if provided, combine it with the user's confirmation, calculate macros accurately, and log it now.
Respond with 1 short sentence (dry wit fine), then on the NEXT LINE output ONLY the JSON:
{"logged":true,"calories":NUMBER,"protein":NUMBER,"label":"SHORT_DESCRIPTION"}
Nothing after the JSON.`
    );
  }

  return (
    base + `

TEXT LOG MODE:

PATH A — Portion is clear: respond with 1 short sentence, then JSON on next line:
{"logged":true,"calories":NUMBER,"protein":NUMBER,"label":"SHORT_DESCRIPTION"}

PATH B — Portion is ambiguous: ask ONE specific clarifying question. End with: NEEDS_CLARIFICATION

Nutrition anchors:
- 1 roti: 120 kcal, 3g protein
- 100g cooked basmati rice: 130 kcal, 3g protein
- 100g firm tofu: 90 kcal, 9g protein
- 100g paneer: 260 kcal, 18g protein
- 100g cooked lentils: 120 kcal, 9g protein
- 100g cooked chickpeas: 165 kcal, 9g protein
- 100g cooked soya chunks: 150 kcal, 18g protein
- 1 scoop whey (30g): 120 kcal, 24g protein
- Chobani Fit 170g: 100 kcal, 15g protein
- Mixed nuts 30g: 180 kcal, 5g protein
- Black coffee: 7 kcal, 0g protein
- 1 banana: 105 kcal, 1g protein
- 1 apple: 95 kcal, 0g protein
- 250ml full cream milk: 160 kcal, 8g protein
- 250ml skim milk: 90 kcal, 9g protein`
  );
}

// ── Parse response ────────────────────────────────────────────────────────────
function parseResponse(text) {
  const jsonMatch = text.match(/\{[^{}]*"logged"\s*:\s*true[^{}]*\}/);
  const needsConfirm =
    text.includes("PENDING_CONFIRMATION") || text.includes("NEEDS_CLARIFICATION");

  if (!jsonMatch) {
    return {
      clean: text.replace(/PENDING_CONFIRMATION|NEEDS_CLARIFICATION/g, "").trim(),
      entry: null,
      needsConfirm,
    };
  }

  try {
    const entry = JSON.parse(jsonMatch[0]);
    const clean = text
      .replace(jsonMatch[0], "")
      .replace(/PENDING_CONFIRMATION|NEEDS_CLARIFICATION/g, "")
      .trim();

    return { clean, entry, needsConfirm: false };
  } catch {
    return { clean: text, entry: null, needsConfirm };
  }
}

// ── Theme constants ───────────────────────────────────────────────────────────
const BG = "#0d0d0f";
const SURF = "#16161a";
const BORDER = "rgba(255,255,255,0.07)";
const CAL = "#f59e0b";
const PROT = "#34d399";
const TEXT = "#f0ece4";
const MUTED = "#6b6672";
const ERR = "#f87171";

// ── Icons ─────────────────────────────────────────────────────────────────────
const IconCamera = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

const IconSend = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const IconUser = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const IconChat = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const IconTrend = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
    <polyline points="17 6 23 6 23 12" />
  </svg>
);

const IconKey = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);

const IconX = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const IconEye = ({ show }) =>
  show ? (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );

// ── Ring ──────────────────────────────────────────────────────────────────────
function Ring({ pct, size = 52, stroke = 5, color, children }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.07)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={circ}
          strokeDashoffset={circ - Math.min(pct, 1) * circ}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(.4,0,.2,1)" }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ── Key Setup Screen ──────────────────────────────────────────────────────────
function KeySetupScreen({ onSave }) {
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function validate() {
    const trimmed = key.trim();
    if (trimmed.length < 20) {
      setError("That doesn't look like a Gemini API key.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": trimmed,
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: "Say OK." }],
              },
            ],
            generationConfig: {
              maxOutputTokens: 10,
            },
          }),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error?.message || "Invalid key");
      }

      onSave(trimmed);
    } catch (e) {
      setError(`Key rejected: ${e.message}`);
    }

    setLoading(false);
  }

  return (
    <div
      style={{
        background: BG,
        color: TEXT,
        fontFamily: "'DM Sans',sans-serif",
        width: "100vw",
        height: "100dvh",
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        overflow: "hidden",
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingLeft: "max(24px, env(safe-area-inset-left, 0px))",
        paddingRight: "max(24px, env(safe-area-inset-right, 0px))",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
        body{background:#0d0d0f;}
        input::placeholder{color:#4a4652;}
        @keyframes fadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
        .fade{animation:fadeUp 0.4s ease both;}
      `}</style>

      <div className="fade" style={{ marginBottom: 32 }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            background: "linear-gradient(135deg,rgba(52,211,153,0.2),rgba(52,211,153,0.05))",
            border: "1px solid rgba(52,211,153,0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 20,
          }}
        >
          <IconKey />
        </div>
        <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.03em", marginBottom: 8 }}>
          Connect your Gemini key
        </div>
        <div style={{ fontSize: 14, color: MUTED, lineHeight: 1.6 }}>
          Your key is stored only on this device. We never see it. Google offers a free tier for some Gemini Flash models, so this may cost you exactly nothing unless you outgrow it.
        </div>
      </div>

      <div className="fade" style={{ animationDelay: "0.08s" }}>
        <div
          style={{
            fontSize: 11,
            color: MUTED,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: 8,
          }}
        >
          Gemini API Key
        </div>

        <div style={{ position: "relative", marginBottom: 12 }}>
          <input
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && validate()}
            type={showKey ? "text" : "password"}
            placeholder="AIza..."
            autoComplete="off"
            spellCheck={false}
            style={{
              width: "100%",
              background: SURF,
              border: `1px solid ${error ? ERR : BORDER}`,
              borderRadius: 12,
              padding: "13px 44px 13px 16px",
              color: TEXT,
              fontSize: 14,
              fontFamily: "'DM Mono',monospace",
              outline: "none",
              transition: "border-color 0.2s",
            }}
            onFocus={(e) => {
              if (!error) e.target.style.borderColor = "rgba(255,255,255,0.2)";
            }}
            onBlur={(e) => {
              if (!error) e.target.style.borderColor = BORDER;
            }}
          />
          <button
            onClick={() => setShowKey((s) => !s)}
            style={{
              position: "absolute",
              right: 14,
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: MUTED,
              display: "flex",
              alignItems: "center",
              padding: 2,
            }}
          >
            <IconEye show={showKey} />
          </button>
        </div>

        {error && (
          <div style={{ fontSize: 12, color: ERR, marginBottom: 12, lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        <button
          onClick={validate}
          disabled={loading || !key.trim()}
          style={{
            width: "100%",
            padding: 14,
            background: key.trim() ? PROT : SURF,
            color: key.trim() ? "#0d0d0f" : MUTED,
            border: "none",
            borderRadius: 12,
            cursor: key.trim() ? "pointer" : "default",
            fontSize: 14,
            fontWeight: 600,
            fontFamily: "'DM Sans',sans-serif",
            transition: "background 0.2s,color 0.2s",
          }}
        >
          {loading ? "Checking key..." : "Save & continue"}
        </button>
      </div>

      <div
        className="fade"
        style={{ animationDelay: "0.16s", marginTop: 24, fontSize: 12, color: MUTED, lineHeight: 1.7 }}
      >
        Need a key?{" "}
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: PROT, textDecoration: "none" }}
        >
          Get one in Google AI Studio
        </a>{" "}
        and paste it here.
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState(() => LS.get("gemini_key") || "");

  function saveKey(k) {
    LS.set("gemini_key", k);
    setApiKey(k);
  }

  function clearKey() {
    LS.remove("gemini_key");
    setApiKey("");
  }

  const [tab, setTab] = useState("log");
  const [profile, setProfile] = useState(() => {
    const saved = LS.getObj("profile") || DEFAULT_PROFILE;
    if (!saved.currentWeight) {
      const wlog = LS.getObj("wlog") || [];
      const latest = [...wlog].sort((a, b) => a.date.localeCompare(b.date)).slice(-1)[0]?.w;
      if (latest) return { ...saved, currentWeight: latest };
    }
    return saved;
  });
  const [editProfile, setEditProfile] = useState(() => LS.getObj("profile") || DEFAULT_PROFILE);
  const [days, setDays] = useState(() => LS.getObj("days") || {});

  const today = todayKey();
  const todayData = days[today] ?? { cals: 0, protein: 0, entries: [] };

  const [weightLog, setWeightLog] = useState(() => LS.getObj("wlog") || [
    { date: "2025-03-03", w: 75.3 },
    { date: "2025-03-04", w: 74.8 },
    { date: "2025-03-05", w: 74.5 },
    { date: "2025-03-06", w: 74.3 },
    { date: "2025-03-07", w: 74.1 },
    { date: "2025-03-08", w: 73.9 },
    { date: "2025-03-09", w: 74.0 },
  ]);
  const [weightInput, setWeightInput] = useState("");

  const [messages, setMessages] = useState([
    {
      role: "assistant",
      text: `Hey${profile.name ? " " + profile.name : ""} — tell me what you ate or snap a photo. I'll handle the numbers.`,
      entry: null,
      needsConfirm: false,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [imageData, setImageData] = useState(null);
  const [pendingCtx, setPendingCtx] = useState(null);

  const chatEndRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    LS.setObj("days", days);
  }, [days]);

  useEffect(() => {
    LS.setObj("profile", profile);
  }, [profile]);

  useEffect(() => {
    LS.setObj("wlog", weightLog);
  }, [weightLog]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  if (!apiKey) return <KeySetupScreen onSave={saveKey} />;

  function commitEntry(entry) {
    setDays((prev) => {
      const d = prev[today] ?? { cals: 0, protein: 0, entries: [] };
      return {
        ...prev,
        [today]: {
          cals: Math.round(d.cals + entry.calories),
          protein: Math.round(d.protein + entry.protein),
          entries: [
            ...d.entries,
            {
              ...entry,
              time: new Date().toLocaleTimeString("en-AU", {
                hour: "2-digit",
                minute: "2-digit",
              }),
            },
          ],
        },
      };
    });
    setPendingCtx(null);
  }

  async function send() {
    const text = input.trim();
    const capturedImg = imageData;
    if (!text && !capturedImg) return;

    setInput("");
    setImageData(null);
    setMessages((prev) => [
      ...prev,
      { role: "user", text: text || "📷 Photo", imageData: capturedImg },
    ]);
    setLoading(true);

    try {
      let mode;
      let userTextForAI;
      let imageForAI = null;

      if (capturedImg) {
        mode = "image_scan";
        userTextForAI =
          text || "Identify this food precisely and ask me to confirm the portion size.";
        imageForAI = capturedImg;
        setPendingCtx({ imageBase64: capturedImg, description: text || null });
      } else if (pendingCtx) {
        mode = "confirm_log";
        userTextForAI = `Original food: "${
          pendingCtx.description || "food in photo"
        }". User confirmed: "${text}". Re-check the image with this confirmation, calculate macros accurately, and log it.`;
        imageForAI = pendingCtx.imageBase64 || null;
      } else {
        mode = "text_log";
        userTextForAI = text;
      }

      const raw = await askGPT({
        apiKey,
        systemPrompt: buildSystemPrompt(profile, todayData, mode),
        userText: userTextForAI,
        imageBase64: imageForAI,
      });

      const { clean, entry, needsConfirm } = parseResponse(raw);

      if (mode === "text_log" && needsConfirm) {
        setPendingCtx({ description: text });
      }

      if (entry) commitEntry(entry);

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: clean,
          entry,
          needsConfirm,
          isVision: mode === "image_scan",
        },
      ]);
    } catch (err) {
      const msg = err.message || "";
      if (
        msg.toLowerCase().includes("api key not valid") ||
        msg.toLowerCase().includes("permission denied") ||
        msg.toLowerCase().includes("unauthenticated")
      ) {
        clearKey();
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: `Error: ${msg}`,
            entry: null,
            needsConfirm: false,
          },
        ]);
      }
      setPendingCtx(null);
    }

    setLoading(false);
  }

  function handlePhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result;
      if (typeof result === "string") {
        setImageData(result.split(",")[1]);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function logWeight() {
    const w = parseFloat(weightInput);
    if (isNaN(w)) return;

    const updated = [...weightLog.filter((e) => e.date !== today), { date: today, w }].sort(
      (a, b) => a.date.localeCompare(b.date)
    );

    setWeightLog(updated);
    setProfile((prev) => ({ ...prev, currentWeight: w }));
    setWeightInput("");
  }

  const calLeft = Math.max(0, profile.calTarget - todayData.cals);
  const calPct = todayData.cals / profile.calTarget;
  const protPct = todayData.protein / profile.proteinTarget;
  const goalDate = projectGoalDate(profile.currentWeight, profile.goalWeight);

  const sortedWeightLog = [...weightLog].sort((a, b) => a.date.localeCompare(b.date));
  const startWeight = sortedWeightLog.length ? sortedWeightLog[0].w : "";

  const recent = weightLog.slice(-7);
  const wVals = recent.map((e) => e.w);
  const wMin = Math.min(...wVals) - 0.5;
  const wMax = Math.max(...wVals) + 0.5;
  const wRange = wMax - wMin || 1;
  const CW = 280;
  const CH = 90;
  const pts = recent.map((e, i) => {
    const x = (i / Math.max(recent.length - 1, 1)) * CW;
    const y = CH - ((e.w - wMin) / wRange) * CH;
    return `${x},${y}`;
  });

  const tabSty = (t) => ({
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: "8px 0",
    cursor: "pointer",
    border: "none",
    background: "none",
    transition: "color 0.2s",
    color: tab === t ? TEXT : MUTED,
    fontSize: 10,
    fontFamily: "'DM Sans',sans-serif",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
  });

  return (
    <div
      style={{
        background: BG,
        color: TEXT,
        fontFamily: "'DM Sans',sans-serif",
        width: "100vw",
        height: "100dvh",
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
        body{background:#0d0d0f;}
        ::-webkit-scrollbar{width:0;height:0;}
        input::placeholder{color:#4a4652;}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
        @keyframes blink{0%,100%{opacity:0.25;}50%{opacity:1;}}
        .msg{animation:fadeUp 0.25s ease both;}
        .dot{animation:blink 1.1s ease-in-out infinite;}
        .dot:nth-child(2){animation-delay:0.18s;}
        .dot:nth-child(3){animation-delay:0.36s;}
        .cam-btn:hover{color:#f0ece4!important;border-color:rgba(255,255,255,0.22)!important;}
      `}</style>

      <div
        style={{
          padding: "16px 20px 12px",
          borderBottom: `1px solid ${BORDER}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: BG,
          flexShrink: 0,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              color: MUTED,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              marginBottom: 2,
            }}
          >
            {tab === "log" ? "Today" : tab === "weight" ? "Progress" : "Profile"}
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.03em" }}>
            {tab === "log"
              ? `${calLeft} kcal left`
              : tab === "weight"
              ? `${profile.currentWeight || "—"} kg`
              : profile.name || "Settings"}
          </div>
        </div>

        {tab === "log" && (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {[
              { pct: calPct, color: CAL, label: "kcal" },
              { pct: protPct, color: PROT, label: "protein" },
            ].map((r) => (
              <div key={r.label} style={{ textAlign: "center" }}>
                <Ring pct={r.pct} size={50} stroke={5} color={r.color}>
                  <span
                    style={{
                      fontSize: 9,
                      color: r.color,
                      fontWeight: 600,
                      fontFamily: "'DM Mono',monospace",
                    }}
                  >
                    {Math.round(r.pct * 100)}%
                  </span>
                </Ring>
                <div style={{ fontSize: 9, color: MUTED, marginTop: 2 }}>{r.label}</div>
              </div>
            ))}
          </div>
        )}

        {tab === "weight" && goalDate && (
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontSize: 10,
                color: MUTED,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              Goal date
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: PROT }}>{goalDate}</div>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {tab === "log" && (
          <>
            <div
              style={{
                display: "flex",
                gap: 10,
                padding: "10px 14px",
                borderBottom: `1px solid ${BORDER}`,
                flexShrink: 0,
              }}
            >
              {[
                {
                  label: "Calories",
                  val: todayData.cals,
                  target: profile.calTarget,
                  unit: "kcal",
                  color: CAL,
                },
                {
                  label: "Protein",
                  val: todayData.protein,
                  target: profile.proteinTarget,
                  unit: "g",
                  color: PROT,
                },
              ].map((m) => (
                <div
                  key={m.label}
                  style={{ flex: 1, background: SURF, borderRadius: 10, padding: "9px 12px" }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      color: MUTED,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      marginBottom: 4,
                    }}
                  >
                    {m.label}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      marginBottom: 5,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 19,
                        fontWeight: 600,
                        color: m.color,
                        fontFamily: "'DM Mono',monospace",
                      }}
                    >
                      {m.val}
                    </span>
                    <span style={{ fontSize: 11, color: MUTED }}>
                      / {m.target}
                      {m.unit}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 3,
                      background: "rgba(255,255,255,0.07)",
                      borderRadius: 99,
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        borderRadius: 99,
                        background: m.color,
                        width: `${Math.min(100, (m.val / m.target) * 100)}%`,
                        transition: "width 0.5s cubic-bezier(.4,0,.2,1)",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {pendingCtx && (
              <div
                style={{
                  margin: "8px 14px 0",
                  padding: "9px 12px",
                  background: "rgba(245,158,11,0.07)",
                  border: "1px solid rgba(245,158,11,0.22)",
                  borderRadius: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexShrink: 0,
                }}
              >
                <span style={{ fontSize: 12, color: CAL }}>↩ Reply to confirm portion &amp; log</span>
                <button
                  onClick={() => setPendingCtx(null)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: MUTED,
                    display: "flex",
                    alignItems: "center",
                    padding: 2,
                  }}
                >
                  <IconX />
                </button>
              </div>
            )}

            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "14px 14px 6px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                WebkitOverflowScrolling: "touch",
                overscrollBehavior: "contain",
              }}
            >
              {messages.map((m, i) => (
                <div
                  key={i}
                  className="msg"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: m.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  {m.imageData && (
                    <img
                      src={`data:image/jpeg;base64,${m.imageData}`}
                      alt="food"
                      style={{
                        maxWidth: 180,
                        borderRadius: 12,
                        marginBottom: 5,
                        opacity: 0.9,
                        objectFit: "cover",
                      }}
                    />
                  )}

                  {m.isVision && (
                    <div
                      style={{
                        fontSize: 10,
                        color: MUTED,
                        marginBottom: 3,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <IconCamera />
                      <span>Gemini Vision</span>
                    </div>
                  )}

                  <div
                    style={{
                      maxWidth: "80%",
                      padding: "9px 13px",
                      fontSize: 14,
                      lineHeight: 1.55,
                      color: TEXT,
                      borderRadius:
                        m.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                      background: m.role === "user" ? "#1f1b2e" : SURF,
                      border: `1px solid ${m.role === "user" ? "rgba(100,80,160,0.22)" : BORDER}`,
                    }}
                  >
                    {m.text}
                  </div>

                  {m.entry && (
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: "'DM Mono',monospace",
                          color: CAL,
                          background: "rgba(245,158,11,0.1)",
                          padding: "2px 8px",
                          borderRadius: 99,
                        }}
                      >
                        +{m.entry.calories} kcal
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: "'DM Mono',monospace",
                          color: PROT,
                          background: "rgba(52,211,153,0.1)",
                          padding: "2px 8px",
                          borderRadius: 99,
                        }}
                      >
                        +{m.entry.protein}g protein
                      </span>
                    </div>
                  )}

                  {m.needsConfirm && m.role === "assistant" && (
                    <div style={{ marginTop: 3, fontSize: 11, color: CAL, opacity: 0.8 }}>
                      ↩ Reply to confirm and log
                    </div>
                  )}
                </div>
              ))}

              {loading && (
                <div
                  className="msg"
                  style={{ display: "flex", gap: 5, padding: "10px 14px", alignItems: "center" }}
                >
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="dot"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: MUTED,
                      }}
                    />
                  ))}
                </div>
              )}

              {imageData && !loading && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 12px",
                    background: "rgba(52,211,153,0.07)",
                    borderRadius: 10,
                    border: "1px solid rgba(52,211,153,0.18)",
                    fontSize: 12,
                    color: PROT,
                  }}
                >
                  <IconCamera /> Photo ready — add a note or send to scan
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            <div
              style={{
                padding: "8px 12px 14px",
                borderTop: `1px solid ${BORDER}`,
                flexShrink: 0,
                display: "flex",
                gap: 8,
                alignItems: "center",
                background: BG,
              }}
            >
              <button
                className="cam-btn"
                onClick={() => fileRef.current?.click()}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  border: `1px solid ${BORDER}`,
                  background: SURF,
                  color: MUTED,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  transition: "color 0.2s,border-color 0.2s",
                }}
              >
                <IconCamera />
              </button>

              <input
                type="file"
                ref={fileRef}
                accept="image/*"
                capture="environment"
                onChange={handlePhoto}
                style={{ display: "none" }}
              />

              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
                placeholder={pendingCtx ? "Reply to confirm portion..." : "What did you eat?"}
                style={{
                  flex: 1,
                  background: SURF,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 20,
                  padding: "10px 16px",
                  color: TEXT,
                  fontSize: 14,
                  fontFamily: "'DM Sans',sans-serif",
                  outline: "none",
                  transition: "border-color 0.2s",
                }}
                onFocus={(e) => (e.target.style.borderColor = "rgba(255,255,255,0.2)")}
                onBlur={(e) => (e.target.style.borderColor = BORDER)}
              />

              <button
                onClick={send}
                disabled={loading || (!input.trim() && !imageData)}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  border: "none",
                  background: input.trim() || imageData ? PROT : SURF,
                  color: input.trim() || imageData ? "#0d0d0f" : MUTED,
                  cursor: input.trim() || imageData ? "pointer" : "default",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  transition: "background 0.2s,color 0.2s",
                }}
              >
                <IconSend />
              </button>
            </div>
          </>
        )}

        {tab === "weight" && (
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "18px 18px 0",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              WebkitOverflowScrolling: "touch",
              overscrollBehavior: "contain",
            }}
          >
            <div
              style={{
                background: SURF,
                borderRadius: 14,
                padding: 16,
                border: `1px solid ${BORDER}`,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: MUTED,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: 10,
                }}
              >
                Log Morning Weight
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={weightInput}
                  onChange={(e) => setWeightInput(e.target.value)}
                  placeholder="e.g. 73.4"
                  type="number"
                  step="0.1"
                  onKeyDown={(e) => e.key === "Enter" && logWeight()}
                  style={{
                    flex: 1,
                    background: BG,
                    border: `1px solid ${BORDER}`,
                    borderRadius: 10,
                    padding: "10px 14px",
                    color: TEXT,
                    fontSize: 15,
                    fontFamily: "'DM Mono',monospace",
                    outline: "none",
                  }}
                />
                <button
                  onClick={logWeight}
                  style={{
                    padding: "10px 18px",
                    background: PROT,
                    color: "#0d0d0f",
                    border: "none",
                    borderRadius: 10,
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    fontFamily: "'DM Sans',sans-serif",
                  }}
                >
                  Log
                </button>
              </div>
            </div>

            <div
              style={{
                background: "linear-gradient(135deg,rgba(52,211,153,0.12),rgba(52,211,153,0.04))",
                borderRadius: 14,
                padding: 16,
                border: "1px solid rgba(52,211,153,0.2)",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: PROT,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: 8,
                }}
              >
                Projected Goal Date
              </div>
              <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.03em", marginBottom: 4 }}>
                {goalDate ?? "—"}
              </div>
              <div style={{ fontSize: 12, color: MUTED }}>
                {profile.currentWeight || "—"} kg → {profile.goalWeight || "—"} kg · at ~0.7 kg/week
              </div>

              <div
                style={{
                  marginTop: 12,
                  height: 4,
                  background: "rgba(255,255,255,0.07)",
                  borderRadius: 99,
                }}
              >
                {(() => {
                  const start = parseFloat(startWeight);
                  const goal = parseFloat(profile.goalWeight);
                  const current = parseFloat(profile.currentWeight);

                  if (isNaN(start) || isNaN(goal) || isNaN(current) || start <= goal) {
                    return (
                      <div
                        style={{
                          height: "100%",
                          width: "0%",
                          background: PROT,
                          borderRadius: 99,
                          transition: "width 0.6s ease",
                        }}
                      />
                    );
                  }

                  const total = start - goal;
                  const done = start - current;
                  const pct = Math.min(100, Math.max(0, (done / total) * 100));

                  return (
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background: PROT,
                        borderRadius: 99,
                        transition: "width 0.6s ease",
                      }}
                    />
                  );
                })()}
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginTop: 4,
                  fontSize: 10,
                  color: MUTED,
                }}
              >
                <span>{startWeight || "—"} kg start</span>
                <span>{profile.goalWeight || "—"} kg goal</span>
              </div>
            </div>

            {recent.length > 1 && (
              <div
                style={{
                  background: SURF,
                  borderRadius: 14,
                  padding: 16,
                  border: `1px solid ${BORDER}`,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: MUTED,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    marginBottom: 14,
                  }}
                >
                  7-Day Trend
                </div>
                <svg width="100%" viewBox={`0 0 ${CW} ${CH}`} style={{ overflow: "visible" }}>
                  <defs>
                    <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={PROT} stopOpacity="0.28" />
                      <stop offset="100%" stopColor={PROT} stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <polyline
                    points={pts.join(" ")}
                    fill="none"
                    stroke={PROT}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <polygon
                    points={`0,${CH} ${pts.join(" ")} ${CW},${CH}`}
                    fill="url(#wg)"
                  />
                  {recent.map((e, i) => {
                    const x = (i / Math.max(recent.length - 1, 1)) * CW;
                    const y = CH - ((e.w - wMin) / wRange) * CH;
                    return (
                      <g key={i}>
                        <circle cx={x} cy={y} r="3" fill={PROT} />
                        <text
                          x={x}
                          y={y - 8}
                          textAnchor="middle"
                          fontSize="9"
                          fill={MUTED}
                          fontFamily="DM Mono"
                        >
                          {e.w}
                        </text>
                      </g>
                    );
                  })}
                </svg>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 8,
                    fontSize: 10,
                    color: MUTED,
                  }}
                >
                  {recent.map((e) => (
                    <span key={e.date}>{e.date.slice(5)}</span>
                  ))}
                </div>
              </div>
            )}

            <div
              style={{
                background: SURF,
                borderRadius: 14,
                padding: 16,
                border: `1px solid ${BORDER}`,
                marginBottom: 18,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: MUTED,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: 10,
                }}
              >
                Weight Log
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[...weightLog].reverse().map((e, i) => (
                  <div
                    key={i}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  >
                    <span style={{ fontSize: 12, color: MUTED }}>{e.date}</span>
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        fontFamily: "'DM Mono',monospace",
                      }}
                    >
                      {e.w} kg
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === "profile" && (
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "18px 18px 0",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              WebkitOverflowScrolling: "touch",
              overscrollBehavior: "contain",
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: MUTED,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Your Goals
            </div>

            {[
              { key: "name", label: "Name", type: "text", unit: "" },
              { key: "currentWeight", label: "Current Weight", type: "number", unit: "kg" },
              { key: "goalWeight", label: "Goal Weight", type: "number", unit: "kg" },
              { key: "calTarget", label: "Daily Calories", type: "number", unit: "kcal" },
              { key: "proteinTarget", label: "Daily Protein", type: "number", unit: "g" },
            ].map((f) => (
              <div
                key={f.key}
                style={{
                  background: SURF,
                  borderRadius: 12,
                  padding: "12px 16px",
                  border: `1px solid ${BORDER}`,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: MUTED,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    marginBottom: 6,
                  }}
                >
                  {f.label}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    value={editProfile[f.key]}
                    onChange={(e) =>
                      setEditProfile((prev) => ({
                        ...prev,
                        [f.key]:
                          f.type === "number" ? parseFloat(e.target.value) || 0 : e.target.value,
                      }))
                    }
                    type={f.type}
                    style={{
                      flex: 1,
                      background: "transparent",
                      border: "none",
                      color: TEXT,
                      fontSize: 18,
                      fontWeight: 500,
                      outline: "none",
                      fontFamily:
                        f.type === "number"
                          ? "'DM Mono',monospace"
                          : "'DM Sans',sans-serif",
                    }}
                  />
                  {f.unit && <span style={{ fontSize: 12, color: MUTED }}>{f.unit}</span>}
                </div>
              </div>
            ))}

            <button
              onClick={() => setProfile({ ...editProfile })}
              style={{
                padding: 14,
                background: PROT,
                color: "#0d0d0f",
                border: "none",
                borderRadius: 12,
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 600,
                fontFamily: "'DM Sans',sans-serif",
                marginTop: 4,
              }}
            >
              Save Profile
            </button>

            <div
              style={{
                marginTop: 8,
                padding: 16,
                background: SURF,
                borderRadius: 12,
                border: `1px solid ${BORDER}`,
                marginBottom: 18,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: MUTED,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: 8,
                }}
              >
                Gemini API Key
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: MUTED,
                  marginBottom: 12,
                  fontFamily: "'DM Mono',monospace",
                  letterSpacing: "0.04em",
                }}
              >
                {apiKey.slice(0, 8)}••••••••••••••••••••
              </div>
              <button
                onClick={clearKey}
                style={{
                  padding: "8px 14px",
                  background: "rgba(248,113,113,0.1)",
                  color: ERR,
                  border: "1px solid rgba(248,113,113,0.2)",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: 12,
                  fontFamily: "'DM Sans',sans-serif",
                }}
              >
                Remove key &amp; sign out
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          borderTop: `1px solid ${BORDER}`,
          background: BG,
          flexShrink: 0,
          paddingBottom: "env(safe-area-inset-bottom,0px)",
        }}
      >
        {[
          { id: "log", icon: <IconChat />, label: "Log" },
          { id: "weight", icon: <IconTrend />, label: "Progress" },
          { id: "profile", icon: <IconUser />, label: "Profile" },
        ].map((t) => (
          <button key={t.id} style={tabSty(t.id)} onClick={() => setTab(t.id)}>
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}