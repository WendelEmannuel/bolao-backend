require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { MercadoPagoConfig, Payment } = require("mercadopago");

const app = express();

const allowedOrigins = (process.env.FRONTEND_URL || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origem não permitida pelo CORS: ${origin}`));
  }
}));

app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN
});

const payment = new Payment(mpClient);
const PIX_AMOUNT = Number(process.env.PIX_AMOUNT || "0.01");

function normalizarEmail(email) {
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
  return "participante@email.com";
}

function extrairTimes(jogo, timeCasa, timeFora) {
  if (timeCasa && timeFora) return { timeCasa, timeFora };

  if (typeof jogo === "string") {
    const partes = jogo
      .replace(/\s+vs\.?\s+/i, " x ")
      .split(/\s+x\s+/i)
      .map((parte) => parte.trim())
      .filter(Boolean);

    if (partes.length >= 2) {
      return { timeCasa: partes[0], timeFora: partes[1] };
    }
  }

  return {
    timeCasa: timeCasa || "Time 1",
    timeFora: timeFora || "Time 2"
  };
}

app.get("/", (req, res) => {
  res.json({ status: "Backend do Bolão funcionando" });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    pix_amount: PIX_AMOUNT,
    timestamp: new Date().toISOString()
  });
});

app.post("/api/criar-pix", async (req, res) => {
  try {
    console.log("[CRIAR_PIX] Requisição recebida", {
      body: { ...req.body, chave_pix: req.body?.chave_pix ? "***" : undefined, pix: req.body?.pix ? "***" : undefined }
    });

    const {
      nome,
      whatsapp,
      email,
      jogo,
      placarCasa,
      placarFora,
      time_casa,
      time_fora,
      timeCasa,
      timeFora
    } = req.body;

    const chave_pix = req.body.chave_pix || req.body.pix || null;

    if (!nome || !whatsapp) {
      return res.status(400).json({ erro: "Nome e WhatsApp são obrigatórios." });
    }

    const { data: participante, error: participanteError } = await supabase
      .from("participantes")
      .insert({
        nome,
        whatsapp,
        email,
        chave_pix,
        status: "aguardando_pagamento"
      })
      .select()
      .single();

    if (participanteError) throw participanteError;

    let aposta = null;

    const temDadosAposta = jogo && placarCasa !== undefined && placarFora !== undefined && placarCasa !== "" && placarFora !== "";

    if (temDadosAposta) {
      const times = extrairTimes(jogo, time_casa || timeCasa, time_fora || timeFora);

      const { data: apostaCriada, error: apostaError } = await supabase
        .from("apostas")
        .insert({
          participante_id: participante.id,
          jogo,
          time_casa: times.timeCasa,
          time_fora: times.timeFora,
          placar_casa: Number(placarCasa),
          placar_fora: Number(placarFora),
          status: "aguardando_pagamento"
        })
        .select()
        .single();

      if (apostaError) throw apostaError;
      aposta = apostaCriada;
    }

    const pagamento = await payment.create({
      body: {
        transaction_amount: PIX_AMOUNT,
        description: "Inscrição Bolão dos Campeões",
        payment_method_id: "pix",
        payer: {
          email: normalizarEmail(email),
          first_name: nome
        },
        external_reference: participante.id,
        metadata: {
          participante_id: participante.id,
          aposta_id: aposta?.id || null
        }
      }
    });

    const qrCode = pagamento?.point_of_interaction?.transaction_data?.qr_code;
    const qrCodeBase64 = pagamento?.point_of_interaction?.transaction_data?.qr_code_base64;

    if (!qrCode || !qrCodeBase64) {
      throw new Error("Mercado Pago não retornou QR Code Pix.");
    }

    const { error: pagamentoError } = await supabase
      .from("pagamentos")
      .insert({
        participante_id: participante.id,
        valor: PIX_AMOUNT,
        status: "pendente",
        mercado_pago_id: String(pagamento.id),
        qr_code: qrCodeBase64,
        copia_cola: qrCode
      });

    if (pagamentoError) throw pagamentoError;

    console.log("[CRIAR_PIX] Pix criado com sucesso", {
      participante_id: participante.id,
      aposta_id: aposta?.id || null,
      pagamento_id: pagamento.id,
      valor: PIX_AMOUNT
    });

    res.json({
      participante_id: participante.id,
      aposta_id: aposta?.id || null,
      pagamento_id: pagamento.id,
      valor: PIX_AMOUNT,
      qr_code_base64: qrCodeBase64,
      copia_cola: qrCode,
      status_url: `/api/status-pagamento/${participante.id}`
    });

  } catch (error) {
    console.error("[CRIAR_PIX] Erro ao criar Pix:", error);
    res.status(500).json({ erro: "Erro ao criar Pix.", detalhe: error.message });
  }
});

app.get("/api/status-pagamento/:participanteId", async (req, res) => {
  try {
    const { participanteId } = req.params;

    const { data: participante, error: participanteError } = await supabase
      .from("participantes")
      .select("id, nome, whatsapp, email, status, criado_em")
      .eq("id", participanteId)
      .single();

    if (participanteError) throw participanteError;

    const { data: pagamentos, error: pagamentosError } = await supabase
      .from("pagamentos")
      .select("id, valor, status, mercado_pago_id, criado_em, pago_em")
      .eq("participante_id", participanteId)
      .order("criado_em", { ascending: false })
      .limit(1);

    if (pagamentosError) throw pagamentosError;

    const { data: apostas, error: apostasError } = await supabase
      .from("apostas")
      .select("id, jogo, time_casa, time_fora, placar_casa, placar_fora, status, criado_em")
      .eq("participante_id", participanteId)
      .order("criado_em", { ascending: false });

    if (apostasError) throw apostasError;

    res.json({
      participante,
      pagamento: pagamentos?.[0] || null,
      apostas: apostas || [],
      aprovado: participante.status === "pago" || pagamentos?.[0]?.status === "aprovado"
    });
  } catch (error) {
    console.error("[STATUS_PAGAMENTO] Erro:", error);
    res.status(500).json({ erro: "Erro ao consultar status do pagamento.", detalhe: error.message });
  }
});

app.get("/api/apostas", async (req, res) => {
  try {
    const status = req.query.status || "ativa";
    const jogo = req.query.jogo;

    let query = supabase
      .from("apostas")
      .select(`
        id,
        jogo,
        time_casa,
        time_fora,
        placar_casa,
        placar_fora,
        status,
        criado_em,
        participante:participantes (
          id,
          nome
        )
      `)
      .eq("status", status)
      .order("criado_em", { ascending: false });

    if (jogo) {
      query = query.eq("jogo", jogo);
    }

    const { data, error } = await query;

    if (error) throw error;

    const apostas = (data || []).map((aposta) => ({
      id: aposta.id,
      nome: aposta.participante?.nome || "Participante",
      participante_id: aposta.participante?.id || null,
      jogo: aposta.jogo,
      time_casa: aposta.time_casa,
      time_fora: aposta.time_fora,
      placar_casa: aposta.placar_casa,
      placar_fora: aposta.placar_fora,
      status: aposta.status,
      criado_em: aposta.criado_em
    }));

    res.json({ apostas });

  } catch (error) {
    console.error("[APOSTAS] Erro ao listar apostas:", error);

    res.status(500).json({
      erro: "Erro ao listar apostas.",
      detalhe: error.message
    });
  }
});

app.get("/api/minhas-apostas", async (req, res) => {
  try {
    const { whatsapp } = req.query;

    if (!whatsapp) {
      return res.status(400).json({ erro: "WhatsApp é obrigatório." });
    }

    const somenteNumeros = String(whatsapp).replace(/\D/g, "");

    const { data, error } = await supabase
      .from("apostas")
      .select(`
        id,
        jogo,
        time_casa,
        time_fora,
        placar_casa,
        placar_fora,
        status,
        criado_em,
        participante:participantes (
          id,
          nome,
          whatsapp,
          status
        )
      `)
      .eq("status", "ativa");

    if (error) throw error;

    const apostas = (data || []).filter((aposta) => {
      const telefoneBanco = String(aposta.participante?.whatsapp || "").replace(/\D/g, "");
      return (
        telefoneBanco === somenteNumeros ||
        telefoneBanco.endsWith(somenteNumeros) ||
        somenteNumeros.endsWith(telefoneBanco)
        );
    });

    res.json({ apostas });

  } catch (error) {
    console.error("[MINHAS_APOSTAS] Erro:", error);
    res.status(500).json({
      erro: "Erro ao buscar suas apostas.",
      detalhe: error.message
    });
  }
});

app.post("/webhook/mercado-pago", async (req, res) => {
  try {
    console.log("[WEBHOOK_MP] Notificação recebida", {
      query: req.query,
      body: req.body
    });

    const paymentId = req.body?.data?.id || req.query?.id || req.query?.['data.id'];

    if (!paymentId) {
      console.log("[WEBHOOK_MP] Sem paymentId. Retornando 200.");
      return res.sendStatus(200);
    }

    const pagamentoMP = await payment.get({ id: paymentId });

    console.log("[WEBHOOK_MP] Pagamento consultado no Mercado Pago", {
      paymentId,
      status: pagamentoMP.status,
      external_reference: pagamentoMP.external_reference,
      metadata: pagamentoMP.metadata
    });

    const participanteId = pagamentoMP.external_reference || pagamentoMP.metadata?.participante_id;
    const apostaId = pagamentoMP.metadata?.aposta_id;

    const statusPagamento = pagamentoMP.status === "approved" ? "aprovado" : pagamentoMP.status;

    const { error: pagamentoUpdateError } = await supabase
      .from("pagamentos")
      .update({
        status: statusPagamento,
        pago_em: pagamentoMP.status === "approved" ? new Date().toISOString() : null
      })
      .eq("mercado_pago_id", String(paymentId));

    if (pagamentoUpdateError) throw pagamentoUpdateError;

    if (pagamentoMP.status === "approved" && participanteId) {
      const { error: participanteUpdateError } = await supabase
        .from("participantes")
        .update({ status: "pago" })
        .eq("id", participanteId);

      if (participanteUpdateError) throw participanteUpdateError;

      let apostasQuery = supabase
        .from("apostas")
        .update({ status: "ativa" });

      if (apostaId) {
        apostasQuery = apostasQuery.eq("id", apostaId);
      } else {
        apostasQuery = apostasQuery.eq("participante_id", participanteId);
      }

      const { error: apostaUpdateError } = await apostasQuery;
      if (apostaUpdateError) throw apostaUpdateError;

      console.log("[WEBHOOK_MP] Pagamento aprovado e dados atualizados", {
        paymentId,
        participanteId,
        apostaId: apostaId || "todas_do_participante"
      });
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("[WEBHOOK_MP] Erro no webhook:", error);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
