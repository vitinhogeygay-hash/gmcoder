// api/allowpay.js
// Limites em memória: camada básica. Em serverless, não são persistentes nem globais.
const API_BASE = "https://allow-gi0i.onrender.com";
const API_KEY = process.env.ALLOWPAY_API_KEY;
const WINDOW_MS = 10 * 60 * 1000;
const CPF_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_QUANTITY = 500;

const state = globalThis.__abuseGuardAllowpay || (globalThis.__abuseGuardAllowpay = {
  byIP: new Map(), byCPF: new Map(), inFlight: new Set()
});

function rateLimit(map, key, limit, windowMs) {
  const now = Date.now();
  const old = map.get(key);
  if (!old || now - old.start >= windowMs) {
    map.set(key, { start: now, count: 1 });
    return true;
  }
  if (old.count >= limit) return false;
  old.count += 1;
  return true;
}

function validCPF(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let digit = (sum * 10) % 11; if (digit === 10) digit = 0;
  if (digit !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  digit = (sum * 10) % 11; if (digit === 10) digit = 0;
  return digit === Number(cpf[10]);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ success: false, error: "Método não permitido." });
  }
  if (!API_KEY) {
    console.error("ALLOWPAY_API_KEY não configurada no ambiente.");
    return res.status(500).json({ success: false, error: "Serviço temporariamente indisponível." });
  }

  const body = req.body || {};
  const cpf = String(body.cpf || "").replace(/\D/g, "");
  const telefone = String(body.telefone || "").replace(/\D/g, "");
  const quantidade = Number(body.quantidade);
  const amount = Number(body.amount);

  if (!validCPF(cpf) || telefone.length < 10 || telefone.length > 13 ||
      !Number.isInteger(quantidade) || quantidade < 15 || quantidade > MAX_QUANTITY ||
      !Number.isFinite(amount) || Math.abs(amount - Number((quantidade * 0.49).toFixed(2))) > 0.01) {
    return res.status(400).json({ success: false, error: "Dados inválidos. Confira CPF, telefone, quantidade e valor." });
  }

  // x-forwarded-for só deve ser confiado quando definido pela própria hospedagem.
  const forwarded = req.headers["x-forwarded-for"];
  const ip = String(req.headers["x-real-ip"] || (typeof forwarded === "string" ? forwarded.split(",")[0] : "") || "ip-desconhecido").trim().slice(0, 100);
  if (!rateLimit(state.byIP, ip, 5, WINDOW_MS)) {
    return res.status(429).json({ success: false, error: "Muitas tentativas. Aguarde alguns minutos." });
  }
  if (state.inFlight.has(cpf)) {
    return res.status(429).json({ success: false, error: "Já existe uma solicitação em andamento para este CPF." });
  }
  const lastCPF = state.byCPF.get(cpf);
  if (lastCPF && Date.now() - lastCPF < CPF_COOLDOWN_MS) {
    return res.status(429).json({ success: false, error: "Já houve uma solicitação recente para este CPF. Aguarde antes de tentar novamente." });
  }

  state.inFlight.add(cpf);
  // Reserva o CPF antes da chamada externa para reduzir duplicações concorrentes.
  state.byCPF.set(cpf, Date.now());
  try {
    const nomeProduto = String(body.produto || "Título de Capitalização").slice(0, 100);
    const payload = {
      api_key: API_KEY,
      amount: Math.round(amount * 100),
      description: `${quantidade} ${nomeProduto}`,
      customer: {
        name: String(body.nome || "Cliente").slice(0, 120),
        email: String(body.email || `${cpf.slice(0, 8)}@temp.com`).slice(0, 200),
        cellphone: telefone,
        taxId: cpf
      }
    };
    const response = await fetch(`${API_BASE}/api/v2/allowpay-seller/create-pix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      console.error("Provedor PIX retornou erro HTTP", response.status);
      return res.status(502).json({ success: false, error: "Não foi possível gerar o PIX agora. Tente mais tarde." });
    }
    const pixCode = data.pix_code || data.pix_qr_code || "";
    if (!pixCode) return res.status(502).json({ success: false, error: "O provedor não retornou o código PIX." });
    const txid = data.txid || `VS-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return res.status(200).json({
      success: true, transaction_id: txid, txid, route: data.route || "safepix",
      qr_code: pixCode, codigo_pix: pixCode,
      qr_code_image: `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(pixCode)}`,
      valor: amount, quantidade,
      expira_em: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
  } catch (error) {
    console.error("Erro ao criar PIX:", error.message);
    return res.status(502).json({ success: false, error: "Falha ao solicitar PIX. Tente novamente mais tarde." });
  } finally {
    state.inFlight.delete(cpf);
  }
}
