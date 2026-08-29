require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());

// Important: Webhook needs raw body parsing to verify the signature securely.
app.use('/api/paymongo/webhook', express.raw({ type: 'application/json' }));

// Standard JSON parsing for the rest of the endpoints
app.use(express.json());

// Serve static frontend files from the "public" directory
app.use(express.static('public'));

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, guests } = req.body;

        // 1. Validate required fields
        if (!tour || !customerName || !customerEmail || !bookingDate || !guests) {
            return res.status(400).json({ error: 'Missing required booking details.' });
        }

        // 2. Pricing Logic: Flat ₱750 rate for up to 5 guests
        let amountInCents = 0;

        // The frontend currently passes the exact string "Alicia Panoramic Park Tour"
        if (tour === "Alicia Panoramic Park Tour") {
            // Flat rate of ₱750. PayMongo expects amounts in centavos (750 * 100 = 75000)
            amountInCents = 75000; 
        } else {
            return res.status(400).json({ error: "Invalid or currently unavailable tour selected." });
        }

        // 3. Prepare the PayMongo Checkout Session payload
        const description = `Booking Date: ${bookingDate} | Guests: ${guests} (Group Flat Rate)`;
        
        const paymongoPayload = {
            data: {
                attributes: {
                    billing: {
                        name: customerName,
                        email: customerEmail,
                        phone: customerPhone || 'N/A'
                    },
                    send_email_receipt: true,
                    show_description: true,
                    show_line_items: true,
                    cancel_url: `${req.protocol}://${req.get('host')}/index.html`,
                    success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
                    description: `TAPP Tours - ${tour}`,
                    line_items: [
                        {
                            currency: 'PHP',
                            amount: flatRateAmount, // 75000 centavos = ₱750.00 flat rate
                            description: `Booking Date: ${bookingDate} | Group Size: ${guests} Guest(s)`,
                            name: tour,
                            quantity: 1 // Quantity 1 guarantees flat group pricing regardless of guest count
                        }
                    ],
                    payment_method_types: ['card', 'gcash', 'paymaya', 'qrph'],
                    success_url: `${protocol}://${host}/success.html`,
                    cancel_url: `${protocol}://${host}/index.html`,
                    metadata: {
                        customerName,
                        customerPhone: customerPhone || 'N/A',
                        bookingDate,
                        guests: guests.toString()
                    }
                    ],
                    // Enable popular local payment methods
                    payment_method_types: ['card', 'gcash', 'paymaya'],
                    metadata: {
                        customerName,
                        customerPhone,
                        bookingDate,
                        guests: guests.toString(),
                        tourName: tour
                    }
                }
            }
        };

        // 4. Authenticate and send request to PayMongo API
        // Encode the secret key in base64 format for Basic Auth
        const encodedKey = Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');

        const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${encodedKey}`
            },
            body: JSON.stringify(paymongoPayload)
        });

        const data = await response.json();

        // 5. Handle response and send checkout URL to frontend
        if (!response.ok || !data.data) {
            console.error("PayMongo Error:", data);
            return res.status(500).json({ error: 'Failed to initiate PayMongo checkout session.' });
        }

        const checkoutUrl = data.data.attributes.checkout_url;
        res.json({ checkoutUrl: checkoutUrl });

    } catch (error) {
        console.error("Checkout Error:", error);
        res.status(500).json({ error: error.message || 'Internal server error while setting up payment.' });
    }
});

// Optional but highly recommended: Webhook to process successful payments automatically
app.post('/api/paymongo/webhook', async (req, res) => {
    const signatureHeader = req.headers['paymongo-signature'];
    const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;

    if (!signatureHeader || !webhookSecret) {
        return res.status(400).send('Missing webhook signature or secret.');
    }

    try {
        const rawBody = req.body.toString('utf8');

        // Parse signature header to get timestamp and signatures
        const sigParts = signatureHeader.split(',').reduce((acc, part) => {
            const [key, value] = part.split('=');
            if (key && value) acc[key.trim()] = value.trim();
            return acc;
        }, {});

        const timestamp = sigParts.t;
        const liveSig = sigParts.li;
        const testSig = sigParts.te;

        // Hash the payload with the webhook secret
        const expectedSignature = crypto
            .createHmac('sha256', webhookSecret)
            .update(`${timestamp}.${rawBody}`)
            .digest('hex');

        // Verify that the payload is genuinely from PayMongo
        const isValidSignature = (liveSig && liveSig === expectedSignature) || (testSig && testSig === expectedSignature);

        if (!isValidSignature) {
            console.error('Invalid PayMongo Webhook Signature');
            return res.status(401).send('Unauthorized webhook signature');
        }

        const event = JSON.parse(rawBody);
        const eventType = event?.data?.attributes?.type;

        // If the payment is successful
        if (eventType === 'checkout_session.payment.paid' || eventType === 'payment.paid') {
            const attributes = event.data.attributes.data.attributes;
            const amountPaid = attributes.amount / 100;
            const metadata = attributes.metadata || {};

            console.log(`✅ Payment successful for ${metadata.customerName || 'Unknown Customer'} - ₱${amountPaid}`);
            console.log('Booking Metadata:', metadata);
            
            // TODO: Here is where you would normally update your database 
            // to mark the booking as "PAID" and send a confirmation email.
        }

        return res.status(200).send('Webhook processed successfully');

    } catch (error) {
        console.error('Webhook execution error:', error);
        return res.status(500).send('Webhook server error');
    }
});

app.listen(PORT, () => {
    console.log(`✅ TAPP Tours server is running on port ${PORT}`);
});