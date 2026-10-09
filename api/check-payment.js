// api/check-payment.js
const API_BASE = "https://allow-gi0i.onrender.com";
const API_KEY = process.env.ALLOWPAY_API_KEY;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ success: false, error: "Método não permitido." });
  }
  if (!API_KEY) {
    console.error("ALLOWPAY_API_KEY não configurada no ambiente.");
    return res.status(500).json({ success: false, error: "Serviço temporariamente indisponível." });
  }
  try {
    const input = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const transactionId = String(input.transaction_id || '').trim();
    const route = String(input.route || 'safepix').trim();
    if (!transactionId || transactionId.length > 150 || !/^[a-zA-Z0-9_-]+$/.test(transactionId)) {
      return res.status(400).json({ success: false, error: 'Identificador de transação inválido.' });
    }
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(route)) {
      return res.status(400).json({ success: false, error: 'Rota inválida.' });
    }
    const url = `${API_BASE}/api/v2/allowpay-seller/payment-status/${encodeURIComponent(transactionId)}?route=${encodeURIComponent(route)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: API_KEY })
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      if (String(data.error || '').includes('não encontrado')) {
        return res.status(200).json({ success: true, transaction_id: transactionId, status: 'pending', allowpay_status: 'pending', amount: 0, last_check: new Date().toISOString() });
      }
      console.error('Erro do provedor ao consultar pagamento:', response.status);
      return res.status(502).json({ success: false, error: 'Não foi possível consultar o pagamento agora.' });
    }
    const originalStatus = String(data.status || 'unknown').toLowerCase();
    const statusMap = {
      paid: 'paid', approved: 'paid', completed: 'paid', waiting_payment: 'pending', pending: 'pending',
      expired: 'expired', failed: 'failed', cancelled: 'canceled', canceled: 'canceled', declined: 'failed',
      refunded: 'refunded', chargeback: 'chargeback'
    };
    return res.status(200).json({
      success: true, transaction_id: transactionId,
      status: statusMap[originalStatus] || 'unknown', allowpay_status: originalStatus,
      source: data.source || 'database', amount: 0, last_check: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erro ao consultar pagamento:', error.message);
    return res.status(502).json({ success: false, error: 'Erro ao consultar o pagamento.' });
  }
}
