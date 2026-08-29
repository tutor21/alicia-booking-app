require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Webhook endpoint needs raw body for signature verification if implementing secret validation
app.use(express.json());

// Serve static files from the "public" directory
app.use(express.static('public'));

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, guests } = req.body;

        if (!tour || !customerName || !customerEmail || !bookingDate || !guests) {
            return res.status(400).json({ error: 'Missing required booking details.' });
        }

        // Flat ₱750 rate (75000 centavos) for group sizes 1 through 5
        let flatRateAmount = 0;

        if (tour === "Alicia Panoramic Park Tour") {
            flatRateAmount = 75000; 
        } else {
            return res.status(400).json({ error: "Invalid or currently unavailable tour selected." });
        }

        const paymongoSecretKey = process.env.PAYMONGO_SECRET_KEY;
        if (!paymongoSecretKey) {
            return res.status(500).json({ error: 'PayMongo secret key is not configured on the server.' });
        }

        const host = req.get('host');
        const protocol = req.protocol;

        const options = {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'Content-Type': 'application/json',
                authorization: `Basic ${Buffer.from(paymongoSecretKey + ':').toString('base64')}`
            },
            body: JSON.stringify({
                data: {
                    attributes: {
                        send_email_receipt: true,
                        show_description: true,
                        show_line_items: true,
                        line_items: [
                            {
                                currency: 'PHP',
                                amount: flatRateAmount, // 75000 centavos = ₱750.00 flat rate
                                description: `Booking Date: ${bookingDate} | Group Size: ${guests} Guest(s)`,
                                name: tour,
                                quantity: 1 // Quantity 1 guarantees flat group pricing regardless of guest count
                            }
                        ],
                        payment_method_types: ['card', 'gcash', 'paymaya'],
                        success_url: `${protocol}://${host}/success.html`,
                        cancel_url: `${protocol}://${host}/index.html`,
                        metadata: {
                            customerName,
                            customerPhone: customerPhone || 'N/A',
                            bookingDate,
                            guests: guests.toString()
                        }
                    }
                }
            })
        };

        const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', options);
        const data = await response.json();

        if (!response.ok) {
            console.error('PayMongo API Error Response:', data);
            const errorMessage = data.errors && data.errors[0] ? data.errors[0].detail : 'Failed to create PayMongo checkout session.';
            return res.status(response.status).json({ error: errorMessage });
        }

        const checkoutUrl = data.data.attributes.checkout_url;
        res.json({ checkoutUrl });

    } catch (error) {
        console.error("PayMongo Checkout Error:", error);
        res.status(500).json({ error: error.message || 'Payment setup failed.' });
    }
});

// PayMongo Webhook Endpoint
app.post('/api/paymongo/webhook', async (req, res) => {
    try {
        const event = req.body.data;
        const eventType = event.attributes.type;

        if (eventType === 'checkout_session.payment.paid') {
            const checkoutData = event.attributes.data;
            const metadata = checkoutData.attributes.metadata;
            
            console.log('Payment Successful! Booking confirmed:', {
                id: checkoutData.id,
                customerName: metadata.customerName,
                customerPhone: metadata.customerPhone,
                bookingDate: metadata.bookingDate,
                guests: metadata.guests,
                amountPaid: checkoutData.attributes.line_items[0].amount / 100
            });

            // TODO: Save to database or dispatch automated email confirmation here
        }

        res.status(200).json({ received: true });
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(400).send(`Webhook Handler Error: ${err.message}`);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});