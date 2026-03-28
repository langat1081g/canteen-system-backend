const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());

// 🔐 Safaricom Credentials
const CONSUMER_KEY = "8yNvxmCqiA7Emf8iz7MBoMNWYGGibTNlIQsexEAsmIfpUDCj";
const CONSUMER_SECRET = "XChBSv2tYMsxoNgrX5plQBivT0DmD2BlcITmVlduqWcF2HZAUXisBi7M6ALjoFL0";
const SHORTCODE = "174379";
const PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";

// 🌐 Backend URL
const BASE_URL = "https://canteen-system-backend.onrender.com";

// 🔥 SUPABASE (⚠️ USE SERVICE ROLE KEY HERE)
const supabase = createClient(
  "https://hbofboaoixzxqzouncyj.supabase.co",
  process.env.SUPABASE_KEY
);

// 🔥 TEMP STORAGE (maps payment → order)
const pendingOrders = {};

// --- GET ACCESS TOKEN ---
const getAccessToken = async () => {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

    const { data } = await axios.get(
        "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
        {
            headers: { Authorization: `Basic ${auth}` }
        }
    );

    return data.access_token;
};

// --- STK PUSH ---
app.post('/stkpush', async (req, res) => {
    const { phone, amount, order_id } = req.body;

    try {
        const token = await getAccessToken();

        const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
        const password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString('base64');

        const response = await axios.post(
            "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
            {
                BusinessShortCode: SHORTCODE,
                Password: password,
                Timestamp: timestamp,
                TransactionType: "CustomerPayBillOnline",
                Amount: amount,
                PartyA: phone,
                PartyB: SHORTCODE,
                PhoneNumber: phone,
                CallBackURL: `${BASE_URL}/callback`,
                AccountReference: order_id,
                TransactionDesc: "Food Order " + order_id
            },
            {
                headers: { Authorization: `Bearer ${token}` }
            }
        );

        console.log("📤 STK SENT:", response.data);

        // 🔥 SAVE MAPPING
        pendingOrders[response.data.CheckoutRequestID] = order_id;

        res.status(200).json(response.data);

    } catch (error) {
        console.error("❌ STK ERROR:", error.response?.data || error.message);
        res.status(500).json(error.response?.data || { error: "STK failed" });
    }
});

// --- CALLBACK ---
app.post('/callback', async (req, res) => {
    try {
        const body = req.body;

        console.log("🔥 CALLBACK RECEIVED:");
        console.log(JSON.stringify(body, null, 2));

        const stkCallback = body.Body.stkCallback;

        if (stkCallback.ResultCode === 0) {

            console.log("✅ PAYMENT SUCCESS");

            const checkoutId = stkCallback.CheckoutRequestID;
            const orderId = pendingOrders[checkoutId];

            // 🔥 EXTRACT RECEIPT
            const metadata = stkCallback.CallbackMetadata?.Item || [];

            let mpesaCode = "";
            let amount = "";
            let phone = "";

            metadata.forEach(item => {
                if (item.Name === "MpesaReceiptNumber") mpesaCode = item.Value;
                if (item.Name === "Amount") amount = item.Value;
                if (item.Name === "PhoneNumber") phone = item.Value;
            });

            console.log("🧾 Receipt:", mpesaCode);

            if(orderId){

                const { error } = await supabase
                  .from("orders")
                  .update({
                    payment_status: "Paid",
                    status: "Confirmed",
                    mpesa_code: mpesaCode
                  })
                  .eq("id", orderId);

                if(error){
                  console.error("❌ DB UPDATE ERROR:", error);
                } else {
                  console.log("✅ CORRECT ORDER UPDATED");
                }

                delete pendingOrders[checkoutId];

            } else {
                console.log("⚠️ Order not found for this payment");
            }

        } else {
            console.log("❌ PAYMENT FAILED:", stkCallback.ResultDesc);
        }

        res.sendStatus(200);

    } catch (error) {
        console.error("❌ CALLBACK ERROR:", error);
        res.sendStatus(500);
    }
});

// --- HEALTH CHECK ---
app.get('/', (req, res) => {
    res.send("🚀 Backend is running");
});

// --- START SERVER ---
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});