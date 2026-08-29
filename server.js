require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serves your front-end files (index.html, etc.)

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'active', timestamp: new Date() });
});

// Create Stripe Checkout Session (Alicia Panoramic Park Tour: Flat rate ₱750 for 1-5 guests)
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { tour, customerName, customerEmail, customerPhone, bookingDate, guests } = req.body;

        // Validation
        if (!tour || !customerName || !customerEmail || !bookingDate || !guests) {
            return res.status(400).json({ error: 'Missing required booking details.' });
        }

        let unitAmount = 0;

        if (tour === "Alicia Panoramic Park Tour") {
            // Flat rate of ₱750 for groups of 1 to 5 guests. 
            // Stripe expects amounts in the smallest currency unit (centavos for PHP), so ₱750 = 75000
            unitAmount = 75000; 
        } else {
            return res.status(400).json({ error: "Invalid or currently unavailable tour selected." });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: customerEmail,
            line_items: [
                {
                    price_data: {
                        currency: 'php',
                        product_data: {
                            name: tour,
                            description: `Booking Date: ${bookingDate} | Group Size: ${guests} Guest(s)`
                        },
                        unit_amount: unitAmount,
                    },
                    quantity: 1, // Quantity 1 for a flat group package rate
                },
            ],
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/index.html`,
            metadata: {
                customerName,
                customerPhone: customerPhone || 'N/A',
                bookingDate,
                guests: guests.toString()
            }
        });

        res.json({ checkoutUrl: session.url });
    } catch (error) {
        console.error("Stripe Checkout Error:", error);
        res.status(500).json({ error: error.message || 'Internal server error while setting up payment.' });
    }
});

// Optional: Webhook endpoint to fulfill orders after successful payment
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`Webhook signature verification failed:`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        // Extract metadata
        const bookingDetails = {
            customerName: session.metadata.customerName,
            customerEmail: session.customer_email,
            customerPhone: session.metadata.customerPhone,
            bookingDate: session.metadata.bookingDate,
            guests: session.metadata.guests,
            amountPaid: session.amount_total / 100,
            paymentIntentId: session.payment_intent
        };

        console.log('Payment Successful! Booking details received:', bookingDetails);
        // TODO: Insert code here to save booking details to your database or send confirmation email
    }

    res.json({ received: true });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});