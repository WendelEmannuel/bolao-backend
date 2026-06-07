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

    console.log("[PIX_DEBUG]", {
    qrCodeExiste: !!qrCode,
    qrCodeTamanho: qrCode?.length || 0,
    qrCodeBase64Existe: !!qrCodeBase64,
    qrCodeBase64Tamanho: qrCodeBase64?.length || 0
    });

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

    console.log("[PIX_RETORNO_FRONT]", {
    copia_cola: qrCode,
    tamanho: qrCode?.length || 0
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

const prazosEdicaoJogos = {
  "México x África do Sul": "2026-06-11T15:55:00",
  "Brasil x Croácia": "2026-06-12T20:55:00",
  "Argentina x Espanha": "2026-06-14T17:55:00",
  "França x Alemanha": "2026-06-16T15:55:00",
  "Portugal x Uruguai": "2026-06-18T19:55:00",
  "Inglaterra x Itália": "2026-06-20T16:55:00"
};

app.put("/api/apostas/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { whatsapp, placarCasa, placarFora } = req.body;

    if (!whatsapp) {
      return res.status(400).json({ erro: "WhatsApp é obrigatório." });
    }

    if (placarCasa === undefined || placarFora === undefined) {
      return res.status(400).json({ erro: "Informe os dois placares." });
    }

    const telefoneInformado = String(whatsapp).replace(/\D/g, "");

    const { data: aposta, error } = await supabase
      .from("apostas")
      .select(`
        id,
        jogo,
        status,
        participante:participantes (
          id,
          whatsapp
        )
      `)
      .eq("id", id)
      .single();

    if (error || !aposta) {
      return res.status(404).json({ erro: "Aposta não encontrada." });
    }

    const telefoneBanco = String(aposta.participante?.whatsapp || "").replace(/\D/g, "");

    const mesmoWhatsapp =
      telefoneBanco === telefoneInformado ||
      telefoneBanco.endsWith(telefoneInformado) ||
      telefoneInformado.endsWith(telefoneBanco);

    if (!mesmoWhatsapp) {
      return res.status(403).json({ erro: "WhatsApp não confere com esta aposta." });
    }

    if (aposta.status !== "ativa") {
      return res.status(403).json({ erro: "Apenas apostas ativas podem ser editadas." });
    }

    const prazoEdicao = prazosEdicaoJogos[aposta.jogo];

    if (prazoEdicao && Date.now() >= new Date(prazoEdicao).getTime()) {
      return res.status(403).json({
        erro: "O prazo para editar esta aposta já encerrou."
      });
    }

    const { data: apostaAtualizada, error: updateError } = await supabase
      .from("apostas")
      .update({
        placar_casa: Number(placarCasa),
        placar_fora: Number(placarFora)
      })
      .eq("id", id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({
      mensagem: "Aposta atualizada com sucesso.",
      aposta: apostaAtualizada
    });

  } catch (error) {
    console.error("[EDITAR_APOSTA] Erro:", error);
    res.status(500).json({
      erro: "Erro ao editar aposta.",
      detalhe: error.message
    });
  }
});

app.get("/api/acertos-rodada", async (req, res) => {
  try {
    const { data: resultados, error: resultadosError } = await supabase
      .from("resultados")
      .select("*")
      .order("criado_em", { ascending: false });

    if (resultadosError) throw resultadosError;

    const retorno = [];

    for (const resultado of resultados || []) {
      const { data: apostas, error: apostasError } = await supabase
        .from("apostas")
        .select("id, participante_id, jogo, placar_casa, placar_fora")
        .eq("status", "ativa")
        .eq("jogo", resultado.jogo)
        .eq("placar_casa", resultado.placar_casa)
        .eq("placar_fora", resultado.placar_fora);

      if (apostasError) throw apostasError;

      const participanteIds = [...new Set((apostas || []).map(a => a.participante_id).filter(Boolean))];

      let participantes = [];

      if (participanteIds.length) {
        const { data, error } = await supabase
          .from("participantes")
          .select("id, nome")
          .in("id", participanteIds);

        if (error) throw error;

        participantes = data || [];
      }

      const nomes = (apostas || []).map((aposta) => {
        const participante = participantes.find(p => p.id === aposta.participante_id);
        return participante?.nome || "Participante";
      });

      retorno.push({
        jogo: resultado.jogo,
        time_casa: resultado.time_casa,
        time_fora: resultado.time_fora,
        placar_casa: resultado.placar_casa,
        placar_fora: resultado.placar_fora,
        ganhadores: nomes
      });
    }

    res.json(retorno);

  } catch (error) {
    console.error("[ACERTOS_RODADA]", error);

    res.status(500).json({
      erro: "Erro ao buscar acertos da rodada.",
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

app.get("/api/resumo-jogos", async (req, res) => {
  try {

    const { data: apostas, error } = await supabase
      .from("apostas")
      .select("jogo")
      .eq("status", "ativa");

    if (error) throw error;

    const resumo = {};

    (apostas || []).forEach((aposta) => {

      if (!resumo[aposta.jogo]) {
        resumo[aposta.jogo] = {
          jogo: aposta.jogo,
          apostadores: 0
        };
      }

      resumo[aposta.jogo].apostadores++;
    });

    const resultado = Object.values(resumo).map((item) => ({
      ...item,
      arrecadado: item.apostadores * 10,
      premio: item.apostadores * 10 * 0.85
    }));

    res.json({
      jogos: resultado
    });

  } catch (erro) {
    console.error(erro);

    res.status(500).json({
      erro: "Erro ao gerar resumo."
    });
  }
});

app.get("/api/ultimos-vencedores", async (req, res) => {
  try {
    const { data: resultados, error: resultadosError } = await supabase
      .from("resultados")
      .select("*")
      .order("criado_em", { ascending: false });

    if (resultadosError) throw resultadosError;

    const vencedores = [];

    for (const resultado of resultados || []) {
      const { data: apostasDoJogo, error: apostasJogoError } = await supabase
        .from("apostas")
        .select("id")
        .eq("status", "ativa")
        .eq("jogo", resultado.jogo);

      if (apostasJogoError) throw apostasJogoError;

      const totalApostas = apostasDoJogo?.length || 0;
      const premioTotal = totalApostas * 10 * 0.85;

      const { data: apostasGanhadoras, error: apostasGanhadorasError } = await supabase
        .from("apostas")
        .select("id, participante_id, jogo, placar_casa, placar_fora")
        .eq("status", "ativa")
        .eq("jogo", resultado.jogo)
        .eq("placar_casa", resultado.placar_casa)
        .eq("placar_fora", resultado.placar_fora);

      if (apostasGanhadorasError) throw apostasGanhadorasError;

      const participanteIds = [
        ...new Set((apostasGanhadoras || []).map(a => a.participante_id).filter(Boolean))
      ];

      let participantes = [];

      if (participanteIds.length) {
        const { data, error } = await supabase
          .from("participantes")
          .select("id, nome")
          .in("id", participanteIds);

        if (error) throw error;
        participantes = data || [];
      }

      const premioPorGanhador =
        apostasGanhadoras?.length > 0
          ? premioTotal / apostasGanhadoras.length
          : 0;

      (apostasGanhadoras || []).forEach((aposta) => {
        const participante = participantes.find(p => p.id === aposta.participante_id);

        vencedores.push({
          nome: participante?.nome || "Participante",
          jogo: resultado.jogo,
          placar: `${resultado.time_casa} ${resultado.placar_casa} x ${resultado.placar_fora} ${resultado.time_fora}`,
          valor: premioPorGanhador,
          criado_em: resultado.criado_em
        });
      });
    }

    res.json({
      vencedores: vencedores.slice(0, 6)
    });

  } catch (error) {
    console.error("[ULTIMOS_VENCEDORES]", error);

    res.status(500).json({
      erro: "Erro ao buscar últimos vencedores.",
      detalhe: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
