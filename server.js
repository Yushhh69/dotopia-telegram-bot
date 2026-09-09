require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const db = require("./database");

const app = express();

const PORT =
    process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN =
    process.env.BOT_TOKEN;

const TELEGRAM_CHANNEL_ID =
    "-1004447270928";

// ==========================================
// MEMBERSHIP AMOUNT
// ==========================================
//
// Amount is stored in paise.
//
// PRODUCTION:
// 149900 = ₹1,499
// ==========================================

const MEMBERSHIP_AMOUNT_PAISE = 149900;

// ==========================================
// RAW BODY FOR RAZORPAY SIGNATURE
// ==========================================

app.use(
    express.json({
        verify: (
            req,
            res,
            buf
        ) => {

            req.rawBody = buf;
        }
    })
);

// ==========================================
// BASIC HEALTH ENDPOINT
// ==========================================

app.get(
    "/",
    (req, res) => {

        res.send(
            "Dotopia payment server is running ✅"
        );
    }
);

// ==========================================
// HEALTH CHECK
// ==========================================

app.get(
    "/health",
    (req, res) => {

        res.json({
            status:
                "ok",

            service:
                "dotopia-payment-server",

            time:
                new Date().toISOString()
        });
    }
);

// ==========================================
// TELEGRAM API
// ==========================================

async function telegramRequest(
    method,
    body
) {

    const url =
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

    const response =
        await fetch(
            url,
            {
                method:
                    "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify(body)
            }
        );

    const data =
        await response.json();

    if (
        !response.ok ||
        !data.ok
    ) {

        throw new Error(
            `Telegram API error: ${JSON.stringify(data)}`
        );
    }

    return data.result;
}

// ==========================================
// CREATE PRIVATE CHANNEL INVITE
// ==========================================

async function createInviteLink(
    membershipEnd
) {

    console.log(
        "🔗 Creating private channel invite..."
    );

    const expirationDate =
        new Date(
            membershipEnd
        );

    const now =
        new Date();

    if (
        expirationDate <= now
    ) {

        throw new Error(
            "Membership expiry is already in the past"
        );
    }

    const expireTimestamp =
        Math.floor(
            expirationDate.getTime() / 1000
        );

    const invite =
        await telegramRequest(
            "createChatInviteLink",
            {
                chat_id:
                    TELEGRAM_CHANNEL_ID,

                member_limit:
                    1,

                expire_date:
                    expireTimestamp,

                creates_join_request:
                    false
            }
        );

    console.log(
        "✅ Invite created:",
        invite.invite_link
    );

    return invite.invite_link;
}

// ==========================================
// SEND NEW MEMBERSHIP ACCESS
// ==========================================

async function sendNewMembershipAccess(
    telegramUserId,
    inviteLink
) {

    console.log(
        "📨 Sending membership access to:",
        telegramUserId
    );

    await telegramRequest(
        "sendMessage",
        {
            chat_id:
                telegramUserId,

            text:
                "🎉 *Your Dotopia membership is active!*\n\n" +
                "Your private-channel access has been activated for 3 months.\n\n" +
                "Click below to join the private Dotopia channel.",

            parse_mode:
                "Markdown",

            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text:
                                "🔐 Join Private Channel",

                            url:
                                inviteLink
                        }
                    ]
                ]
            }
        }
    );

    console.log(
        "✅ Membership access sent"
    );
}

// ==========================================
// SEND RENEWAL CONFIRMATION
// ==========================================

async function sendRenewalConfirmation(
    telegramUserId,
    membershipEnd,
    inviteLink
) {

    console.log(
        "📨 Sending renewal confirmation to:",
        telegramUserId
    );

    await telegramRequest(
        "sendMessage",
        {
            chat_id:
                telegramUserId,

            text:
                "🎉 *Membership Renewed!*\n\n" +
                "Your Dotopia membership has been extended by another 3 months.\n\n" +
                "📅 New expiry:\n" +
                membershipEnd.toLocaleString(
                    "en-IN",
                    {
                        dateStyle:
                            "long",

                        timeStyle:
                            "short",

                        timeZone:
                            "Asia/Kolkata"
                    }
                ) +
                "\n\n" +
                "Your existing channel access remains active.\n\n" +
                "If you need to rejoin the private channel, use the button below.",

            parse_mode:
                "Markdown",

            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text:
                                "🔐 Join Private Channel",

                            url:
                                inviteLink
                        }
                    ]
                ]
            }
        }
    );

    console.log(
        "✅ Renewal confirmation sent"
    );
}

// ==========================================
// ADD 3 CALENDAR MONTHS
// ==========================================

function addThreeMonths(
    date
) {

    const result =
        new Date(
            date
        );

    result.setMonth(
        result.getMonth() + 3
    );

    return result;
}

// ==========================================
// GET EXISTING PAYMENT
// ==========================================

function getPaymentById(
    paymentId
) {

    return db.prepare(`
        SELECT *
        FROM payments
        WHERE payment_id = ?
        LIMIT 1
    `).get(
        paymentId
    );
}

// ==========================================
// GET ACTIVE MEMBERSHIP
// ==========================================

function getActiveMembership(
    telegramUserId
) {

    return db.prepare(`
        SELECT *
        FROM memberships
        WHERE telegram_user_id = ?
          AND status = 'active'
        ORDER BY membership_end DESC
        LIMIT 1
    `).get(
        telegramUserId
    );
}

// ==========================================
// PREPARE PAYMENT FULFILLMENT
// ==========================================
//
// IMPORTANT:
//
// This function performs ONLY DATABASE work.
//
// It does NOT call Telegram.
//
// That makes the payment state durable before
// any external fulfillment begins.
// ==========================================

function preparePaymentFulfillment({
    telegramUserId,
    paymentId,
    paymentLinkId,
    orderId,
    referenceId,
    amount,
    razorpayEventId
}) {

    const transaction =
        db.transaction(
            () => {

                // ----------------------------------
                // Check whether this exact payment
                // already exists.
                // ----------------------------------

                const existingPayment =
                    getPaymentById(
                        paymentId
                    );

                if (
                    existingPayment
                ) {

                    console.log(
                        "↻ Existing payment found:",
                        existingPayment.payment_id
                    );

                    return {
                        payment:
                            existingPayment,

                        created:
                            false
                    };
                }

                // ----------------------------------
                // Find active membership.
                // ----------------------------------

                const existingMembership =
                    getActiveMembership(
                        telegramUserId
                    );

                const now =
                    new Date();

                let membership;
                let fulfillmentType;

                // ==================================
                // ACTIVE MEMBERSHIP → RENEWAL
                // ==================================

                if (
                    existingMembership &&
                    new Date(
                        existingMembership.membership_end
                    ) > now
                ) {

                    fulfillmentType =
                        "renewal";

                    const oldEnd =
                        new Date(
                            existingMembership.membership_end
                        );

                    const newEnd =
                        addThreeMonths(
                            oldEnd
                        );

                    console.log(
                        "🔄 Preparing renewal"
                    );

                    console.log(
                        "Old expiry:",
                        oldEnd.toISOString()
                    );

                    console.log(
                        "New expiry:",
                        newEnd.toISOString()
                    );

                    // ----------------------------------
                    // Extend membership ONCE.
                    //
                    // Because this happens inside the
                    // transaction and payment_id is
                    // linked immediately, a webhook
                    // retry cannot extend it again.
                    // ----------------------------------

                    db.prepare(`
                        UPDATE memberships
                        SET
                            payment_id = ?,
                            payment_link_id = ?,
                            order_id = ?,
                            reference_id = ?,
                            amount_paise = ?,
                            membership_end = ?,
                            reminder_7_sent = 0,
                            reminder_1_sent = 0,
                            expiry_notification_sent = 0
                        WHERE id = ?
                    `).run(
                        paymentId,
                        paymentLinkId,
                        orderId,
                        referenceId,
                        Number(
                            amount
                        ),
                        newEnd.toISOString(),
                        existingMembership.id
                    );

                    membership =
                        db.prepare(`
                            SELECT *
                            FROM memberships
                            WHERE id = ?
                        `).get(
                            existingMembership.id
                        );
                }

                // ==================================
                // NO ACTIVE MEMBERSHIP → NEW
                // ==================================

                else {

                    fulfillmentType =
                        "new";

                    const membershipStart =
                        now;

                    const membershipEnd =
                        addThreeMonths(
                            membershipStart
                        );

                    console.log(
                        "🆕 Preparing new membership"
                    );

                    const result =
                        db.prepare(`
                            INSERT INTO memberships (
                                telegram_user_id,
                                payment_id,
                                payment_link_id,
                                order_id,
                                reference_id,
                                amount_paise,
                                membership_start,
                                membership_end,
                                status,
                                reminder_7_sent,
                                reminder_1_sent,
                                expiry_notification_sent
                            )
                            VALUES (
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                ?,
                                'active',
                                0,
                                0,
                                0
                            )
                        `).run(
                            telegramUserId,
                            paymentId,
                            paymentLinkId,
                            orderId,
                            referenceId,
                            Number(
                                amount
                            ),
                            membershipStart.toISOString(),
                            membershipEnd.toISOString()
                        );

                    membership =
                        db.prepare(`
                            SELECT *
                            FROM memberships
                            WHERE id = ?
                        `).get(
                            result.lastInsertRowid
                        );
                }

                // ==================================
                // CREATE PAYMENT RECORD
                // ==================================
                //
                // Payment is deliberately inserted
                // AFTER membership creation/update,
                // but still inside the SAME transaction.
                //
                // Therefore either BOTH changes
                // happen or NEITHER happens.
                // ==================================

                const paymentResult =
                    db.prepare(`
                        INSERT INTO payments (
                            telegram_user_id,
                            payment_id,
                            payment_link_id,
                            order_id,
                            reference_id,
                            amount_paise,
                            payment_status,
                            razorpay_event_id,
                            fulfillment_status,
                            membership_id,
                            fulfillment_type,
                            last_error
                        )
                        VALUES (
                            ?,
                            ?,
                            ?,
                            ?,
                            ?,
                            ?,
                            'paid',
                            ?,
                            'processing',
                            ?,
                            ?,
                            NULL
                        )
                    `).run(
                        telegramUserId,
                        paymentId,
                        paymentLinkId,
                        orderId,
                        referenceId,
                        Number(
                            amount
                        ),
                        razorpayEventId,
                        membership.id,
                        fulfillmentType
                    );

                console.log(
                    "💾 Payment saved:",
                    paymentResult.lastInsertRowid
                );

                console.log(
                    "🆔 Membership ID:",
                    membership.id
                );

                console.log(
                    "📦 Fulfillment type:",
                    fulfillmentType
                );

                console.log(
                    "⏳ Fulfillment status: processing"
                );

                return {
                    payment:
                        db.prepare(`
                            SELECT *
                            FROM payments
                            WHERE payment_id = ?
                        `).get(
                            paymentId
                        ),

                    membership,

                    created:
                        true
                };
            }
        );

    return transaction();
}

// ==========================================
// FULFILL EXISTING PAYMENT
// ==========================================
//
// This function is safe to call repeatedly.
//
// If the payment is already completed,
// nothing happens.
//
// If it is processing, Telegram fulfillment
// is attempted.
//
// IMPORTANT:
//
// Membership time is NOT changed here.
//
// Membership time was already committed by
// preparePaymentFulfillment().
// ==========================================

async function fulfillPayment(
    paymentId
) {

    const payment =
        getPaymentById(
            paymentId
        );

    if (!payment) {

        throw new Error(
            "Payment not found for fulfillment"
        );
    }

    // ======================================
    // ALREADY COMPLETED
    // ======================================

    if (
        payment.fulfillment_status ===
        "completed"
    ) {

        console.log(
            "✅ Payment already fulfilled:",
            paymentId
        );

        return {
            status:
                "completed",

            alreadyCompleted:
                true
        };
    }

    // ======================================
    // ONLY PROCESS PROCESSING PAYMENTS
    // ======================================

    if (
        payment.fulfillment_status !==
        "processing"
    ) {

        throw new Error(
            `Unexpected fulfillment status: ${payment.fulfillment_status}`
        );
    }

    const membership =
        db.prepare(`
            SELECT *
            FROM memberships
            WHERE id = ?
            LIMIT 1
        `).get(
            payment.membership_id
        );

    if (!membership) {

        throw new Error(
            "Membership linked to payment was not found"
        );
    }

    console.log("");
    console.log(
        "=========================================="
    );

    console.log(
        "📦 FULFILLING PAYMENT"
    );

    console.log(
        "=========================================="
    );

    console.log(
        "Payment:",
        payment.payment_id
    );

    console.log(
        "User:",
        payment.telegram_user_id
    );

    console.log(
        "Membership:",
        membership.id
    );

    console.log(
        "Type:",
        payment.fulfillment_type
    );

    try {

        // ==================================
        // NEW MEMBERSHIP
        // ==================================

        if (
            payment.fulfillment_type ===
            "new"
        ) {

            let inviteLink =
                membership.invite_link;

            // ----------------------------------
            // If an invite was already created
            // before a crash, reuse it.
            // ----------------------------------

            if (
                !inviteLink
            ) {

                inviteLink =
                    await createInviteLink(
                        membership.membership_end
                    );

                db.prepare(`
                    UPDATE memberships
                    SET invite_link = ?
                    WHERE id = ?
                `).run(
                    inviteLink,
                    membership.id
                );

                console.log(
                    "🔗 Invite saved"
                );

            } else {

                console.log(
                    "↻ Existing invite found; reusing it"
                );
            }

            await sendNewMembershipAccess(
                payment.telegram_user_id,
                inviteLink
            );
        }

        // ==================================
        // RENEWAL
        // ==================================

        else if (
            payment.fulfillment_type ===
            "renewal"
        ) {

            console.log(
                "🔄 Creating fresh renewal invite..."
            );

            const inviteLink =
                await createInviteLink(
                    membership.membership_end
                );

            db.prepare(`
                UPDATE memberships
                SET invite_link = ?
                WHERE id = ?
            `).run(
                inviteLink,
                membership.id
            );

            console.log(
                "💾 Fresh renewal invite saved"
            );

            await sendRenewalConfirmation(
                payment.telegram_user_id,
                new Date(
                    membership.membership_end
                ),
                inviteLink
            );
        }

        // ==================================
        // UNKNOWN TYPE
        // ==================================

        else {

            throw new Error(
                `Unknown fulfillment type: ${payment.fulfillment_type}`
            );
        }

        // ==================================
        // MARK COMPLETED
        // ==================================

        db.prepare(`
            UPDATE payments
            SET
                fulfillment_status = 'completed',
                last_error = NULL
            WHERE payment_id = ?
              AND fulfillment_status = 'processing'
        `).run(
            payment.payment_id
        );

        console.log(
            "✅ Payment fulfillment marked completed"
        );

        console.log(
            "🎉 PAYMENT FULFILLMENT COMPLETE"
        );

        console.log(
            "=========================================="
        );

        return {
            status:
                "completed",

            alreadyCompleted:
                false
        };

    } catch (error) {

        const errorMessage =
            String(
                error?.message ||
                error
            ).slice(
                0,
                1000
            );

        db.prepare(`
            UPDATE payments
            SET
                fulfillment_status = 'processing',
                last_error = ?
            WHERE payment_id = ?
        `).run(
            errorMessage,
            payment.payment_id
        );

        console.error(
            "❌ Fulfillment failed:"
        );

        console.error(
            errorMessage
        );

        throw error;
    }
}

// ==========================================
// RAZORPAY WEBHOOK
// ==========================================

app.post(
    "/razorpay-webhook",
    async (
        req,
        res
    ) => {

        try {

            console.log("");
            console.log(
                "=========================================="
            );
            console.log(
                "📥 RAZORPAY WEBHOOK RECEIVED"
            );
            console.log(
                "=========================================="
            );

            // ==================================
            // WEBHOOK SECRET
            // ==================================

            const webhookSecret =
                process.env
                    .RAZORPAY_WEBHOOK_SECRET;

            if (!webhookSecret) {

                console.error(
                    "❌ RAZORPAY_WEBHOOK_SECRET missing"
                );

                return res
                    .status(500)
                    .send(
                        "Webhook secret missing"
                    );
            }

            // ==================================
            // EVENT ID
            // ==================================

            const razorpayEventId =
                req.headers[
                    "x-razorpay-event-id"
                ];

            if (!razorpayEventId) {

                console.error(
                    "❌ Razorpay event ID missing"
                );

                return res
                    .status(400)
                    .send(
                        "Event ID missing"
                    );
            }

            console.log(
                "🆔 Razorpay Event ID:",
                razorpayEventId
            );

            // ==================================
            // SIGNATURE
            // ==================================

            const receivedSignature =
                req.headers[
                    "x-razorpay-signature"
                ];

            if (!receivedSignature) {

                console.error(
                    "❌ Razorpay signature missing"
                );

                return res
                    .status(400)
                    .send(
                        "Signature missing"
                    );
            }

            const expectedSignature =
                crypto
                    .createHmac(
                        "sha256",
                        webhookSecret
                    )
                    .update(
                        req.rawBody
                    )
                    .digest(
                        "hex"
                    );

            if (
                receivedSignature !==
                expectedSignature
            ) {

                console.error(
                    "❌ Invalid Razorpay webhook signature"
                );

                return res
                    .status(400)
                    .send(
                        "Invalid signature"
                    );
            }

            console.log(
                "✅ Valid Razorpay webhook received"
            );

            // ==================================
            // EVENT
            // ==================================

            const event =
                req.body.event;

            console.log(
                "📦 Event:",
                event
            );

            if (
                event !==
                "payment_link.paid"
            ) {

                console.log(
                    "ℹ️ Event ignored"
                );

                return res
                    .status(200)
                    .send(
                        "Event ignored"
                    );
            }

            console.log(
                "💰 PAYMENT SUCCESSFUL"
            );

            // ==================================
            // PAYLOAD
            // ==================================

            const payload =
                req.body.payload ||
                {};

            const paymentLink =
                payload
                    .payment_link
                    ?.entity;

            const order =
                payload
                    .order
                    ?.entity;

            const payment =
                payload
                    .payment
                    ?.entity;

            const paymentLinkId =
                paymentLink?.id ||
                "";

            const orderId =
                order?.id ||
                "";

            const paymentId =
                payment?.id ||
                "";

            const referenceId =
                order?.reference_id ||
                paymentLink?.reference_id ||
                "";

            const amount =
                payment?.amount ||
                order?.amount_paid ||
                paymentLink?.amount_paid ||
                paymentLink?.amount ||
                0;

            console.log(
                "Payment Link ID:",
                paymentLinkId
            );

            console.log(
                "Order ID:",
                orderId
            );

            console.log(
                "Payment ID:",
                paymentId
            );

            console.log(
                "Reference ID:",
                referenceId
            );

            console.log(
                "Amount:",
                amount
            );

            // ==================================
            // BASIC PAYLOAD VALIDATION
            // ==================================

            if (!paymentId) {

                console.error(
                    "❌ Payment ID missing"
                );

                return res
                    .status(400)
                    .send(
                        "Payment ID missing"
                    );
            }

            if (!referenceId) {

                console.error(
                    "❌ Reference ID missing"
                );

                return res
                    .status(400)
                    .send(
                        "Reference ID missing"
                    );
            }

            // ==================================
            // AMOUNT VERIFICATION
            // ==================================

            if (
                Number(amount) !==
                MEMBERSHIP_AMOUNT_PAISE
            ) {

                console.error(
                    "❌ Invalid payment amount:",
                    amount
                );

                return res
                    .status(400)
                    .send(
                        "Invalid payment amount"
                    );
            }

            console.log(
                "✅ Payment amount verified"
            );

            // ==================================
            // TELEGRAM USER ID
            // ==================================

            const match =
                referenceId.match(
                    /^TG_(\d+)_/
                );

            const telegramUserId =
                match
                    ? match[1]
                    : null;

            if (!telegramUserId) {

                console.error(
                    "❌ Telegram user ID not found in reference"
                );

                return res
                    .status(400)
                    .send(
                        "Telegram user not found"
                    );
            }

            console.log(
                "👤 Telegram User ID:",
                telegramUserId
            );

            // ==================================
            // EXISTING PAYMENT CHECK
            // ==================================

            const existingPayment =
                getPaymentById(
                    paymentId
                );

            // ==================================
            // PAYMENT ALREADY EXISTS
            // ==================================
            //
            // This is the critical difference from
            // the old implementation.
            //
            // If it is processing, we RETRY
            // fulfillment.
            //
            // We do NOT create another membership
            // or extend the existing membership again.
            // ==================================

            if (
                existingPayment
            ) {

                console.log(
                    "↻ Existing payment found"
                );

                console.log(
                    "Fulfillment:",
                    existingPayment.fulfillment_status
                );

                if (
                    existingPayment.fulfillment_status ===
                    "completed"
                ) {

                    console.log(
                        "✅ Payment already completely fulfilled"
                    );

                    return res
                        .status(200)
                        .send(
                            "Already processed"
                        );
                }

                if (
                    existingPayment.fulfillment_status ===
                    "processing"
                ) {

                    console.log(
                        "🔄 Payment is processing; retrying fulfillment"
                    );

                    try {

                        await fulfillPayment(
                            paymentId
                        );

                        return res
                            .status(200)
                            .send(
                                "Recovered"
                            );

                    } catch (error) {

                        console.error(
                            "⚠️ Fulfillment retry failed"
                        );

                        return res
                            .status(500)
                            .send(
                                "Fulfillment retry failed"
                            );
                    }
                }

                return res
                    .status(500)
                    .send(
                        "Unexpected payment state"
                    );
            }

            // ==================================
            // FIRST PROCESSING OF PAYMENT
            // ==================================

            console.log(
                "🆕 New payment — preparing fulfillment state"
            );

            let prepared;

            try {

                prepared =
                    preparePaymentFulfillment({
                        telegramUserId,
                        paymentId,
                        paymentLinkId,
                        orderId,
                        referenceId,
                        amount,
                        razorpayEventId
                    });

            } catch (error) {

                // ----------------------------------
                // Unique constraint means another
                // webhook won a race.
                // ----------------------------------

                if (
                    String(
                        error.message
                    ).includes(
                        "UNIQUE constraint failed"
                    )
                ) {

                    console.log(
                        "⚠️ Payment was created by another webhook attempt"
                    );

                    const paymentAfterRace =
                        getPaymentById(
                            paymentId
                        );

                    if (
                        paymentAfterRace &&
                        paymentAfterRace.fulfillment_status ===
                            "processing"
                    ) {

                        try {

                            await fulfillPayment(
                                paymentId
                            );

                            return res
                                .status(200)
                                .send(
                                    "Recovered"
                                );

                        } catch (
                            fulfillmentError
                        ) {

                            console.error(
                                fulfillmentError
                            );

                            return res
                                .status(500)
                                .send(
                                    "Fulfillment retry failed"
                                );
                        }
                    }

                    return res
                        .status(200)
                        .send(
                            "Already processed"
                        );
                }

                throw error;
            }

            console.log(
                "🆔 Membership ID:",
                prepared.membership.id
            );

            console.log(
                "📦 Fulfillment type:",
                prepared.payment.fulfillment_type
            );

            console.log(
                "⏳ Payment state committed as processing"
            );

            // ==================================
            // TELEGRAM FULFILLMENT
            // ==================================

            try {

                await fulfillPayment(
                    paymentId
                );

            } catch (error) {

                console.error(
                    "⚠️ Payment committed but fulfillment failed"
                );

                console.error(
                    error.message
                );

                // ----------------------------------
                // IMPORTANT:
                //
                // Returning 500 tells Razorpay that
                // the webhook was not fully handled.
                //
                // Our payment remains processing,
                // so the recovery worker can safely
                // retry it.
                // ----------------------------------

                return res
                    .status(500)
                    .send(
                        "Fulfillment failed"
                    );
            }

            return res
                .status(200)
                .send(
                    "OK"
                );

        } catch (error) {

            console.error("");
            console.error(
                "❌ WEBHOOK PROCESSING ERROR"
            );

            console.error(
                error
            );

            console.error("");

            return res
                .status(500)
                .send(
                    "Server error"
                );
        }
    }
);

// ==========================================
// START SERVER
// ==========================================

app.listen(
    PORT,
    () => {

        console.log("");

        console.log(
            "=========================================="
        );

        console.log(
            "🌐 Dotopia payment server"
        );

        console.log(
            "=========================================="
        );

        console.log(
            "Port:",
            PORT
        );

        console.log(
            "📢 Telegram channel:",
            TELEGRAM_CHANNEL_ID
        );

        console.log(
            "💰 Membership amount: ₹1,499"
        );

        console.log(
            "💾 Database: dotopia.db"
        );

        console.log(
            "🛡️ Crash-safe fulfillment: enabled"
        );

        console.log(
            "🔄 Duplicate-safe renewal: enabled"
        );

        console.log(
            "📦 Fulfillment recovery: enabled"
        );

        console.log(
            "=========================================="
        );

        console.log("");
    }
);