require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { MercadoPagoConfig, Payment } = require("mercadopago");

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || "*"
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

app.get("/", (req, res) => {
  res.json({ status: "Backend do Bolão funcionando" });
});

app.post("/api/criar-pix", async (req, res) => {
  try {
    const { nome, whatsapp, email, chave_pix } = req.body;

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

    const pagamento = await payment.create({
      body: {
        transaction_amount: 10,
        description: "Inscrição Bolão dos Campeões",
        payment_method_id: "pix",
        payer: {
          email: email || "participante@email.com",
          first_name: nome
        },
        external_reference: participante.id
      }
    });

    const qrCode = pagamento.point_of_interaction.transaction_data.qr_code;
    const qrCodeBase64 = pagamento.point_of_interaction.transaction_data.qr_code_base64;

    const { error: pagamentoError } = await supabase
      .from("pagamentos")
      .insert({
        participante_id: participante.id,
        valor: 10,
        status: "pendente",
        mercado_pago_id: String(pagamento.id),
        qr_code: qrCodeBase64,
        copia_cola: qrCode
      });

    if (pagamentoError) throw pagamentoError;

    res.json({
      participante_id: participante.id,
      pagamento_id: pagamento.id,
      qr_code_base64: qrCodeBase64,
      copia_cola: qrCode
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ erro: "Erro ao criar Pix." });
  }
});

app.post("/webhook/mercado-pago", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id || req.query?.id;

    if (!paymentId) {
      return res.sendStatus(200);
    }

    const pagamentoMP = await payment.get({ id: paymentId });

    if (pagamentoMP.status === "approved") {
      const participanteId = pagamentoMP.external_reference;

      await supabase
        .from("pagamentos")
        .update({
          status: "aprovado",
          pago_em: new Date().toISOString()
        })
        .eq("mercado_pago_id", String(paymentId));

      await supabase
        .from("participantes")
        .update({
          status: "pago"
        })
        .eq("id", participanteId);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});