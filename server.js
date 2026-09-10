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

/* ==========================================
   PRIVATE ADMIN DASHBOARD
   ========================================== */

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";

function adminAuth(req, res, next) {

    const auth = req.headers.authorization;

    if (!auth || !auth.startsWith("Basic ")) {
        res.setHeader(
            "WWW-Authenticate",
            'Basic realm="Dotopia Admin"'
        );
        return res.status(401).send("Authentication required");
    }

    try {

        const decoded = Buffer
            .from(auth.slice(6), "base64")
            .toString("utf8");

        const separator = decoded.indexOf(":");

        if (separator === -1) {
            throw new Error("Invalid authentication");
        }

        const username = decoded.slice(0, separator);
        const password = decoded.slice(separator + 1);

        const expectedPassword =
            process.env.ADMIN_PASSWORD || "";

        const usernameValid =
            username === ADMIN_USERNAME;

        const passwordValid =
            password === expectedPassword;

        if (!usernameValid || !passwordValid) {
            throw new Error("Invalid credentials");
        }

        next();

    } catch (error) {

        res.setHeader(
            "WWW-Authenticate",
            'Basic realm="Dotopia Admin"'
        );

        return res
            .status(401)
            .send("Invalid credentials");
    }
}

app.use("/admin", adminAuth);


/* ==========================================
   ADMIN DASHBOARD PAGE
   ========================================== */

app.get("/admin", (req, res) => {

    const html = [
        "<!DOCTYPE html>",
        "<html>",
        "<head>",
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        "<title>Dotopia Admin Dashboard</title>",

        "<style>",

        "*{box-sizing:border-box}",

        "body{",
        "margin:0;",
        "font-family:Arial,Helvetica,sans-serif;",
        "background:#0f172a;",
        "color:#e5e7eb;",
        "}",

        ".container{",
        "max-width:1400px;",
        "margin:auto;",
        "padding:30px;",
        "}",

        "h1{margin:0;font-size:30px}",

        ".subtitle{",
        "margin-top:6px;",
        "color:#6b7280;",
        "}",

        ".cards{",
        "display:grid;",
        "grid-template-columns:repeat(auto-fit,minmax(190px,1fr));",
        "gap:16px;",
        "margin-top:28px;",
        "}",

        ".card{",
        "background:#1e293b;",
        "border-radius:14px;",
        "padding:20px;",
        "box-shadow:0 2px 10px rgba(0,0,0,.06);",
        "}",

        ".card-title{",
        "color:#94a3b8;",
        "font-size:13px;",
        "margin-bottom:10px;",
        "}",

        ".card-value{",
        "font-size:28px;",
        "font-weight:bold;",
        "}",

        ".section{",
        "background:#1e293b;",
        "border-radius:14px;",
        "margin-top:24px;",
        "padding:22px;",
        "box-shadow:0 2px 10px rgba(0,0,0,.06);",
        "overflow-x:auto;",
        "}",

        ".section h2{",
        "margin-top:0;",
        "font-size:20px;",
        "}",

        "table{",
        "width:100%;",
        "border-collapse:collapse;",
        "min-width:850px;",
        "}",

        "th,td{",
        "padding:12px 10px;",
        "border-bottom:1px solid #334155;",
        "text-align:left;",
        "font-size:14px;",
        "}",

        "th{",
        "color:#6b7280;",
        "font-weight:600;",
        "}",

        "button{",
        "border:0;",
        "border-radius:8px;",
        "padding:8px 12px;",
        "cursor:pointer;",
        "font-weight:600;",
        "background:#f1f5f9;",
        "color:#0f172a;",
        "}",

        ".status{",
        "display:inline-block;",
        "padding:5px 9px;",
        "border-radius:999px;",
        "font-size:12px;",
        "font-weight:600;",
        "}",

        ".active{background:#dcfce7;color:#166534}",
        ".expired{background:#fee2e2;color:#991b1b}",
        ".processing{background:#fef3c7;color:#92400e}",
        ".completed{background:#dcfce7;color:#166534}",

        ".empty{",
        "padding:20px 0;",
        "color:#6b7280;",
        "}",

        ".refresh{",
        "float:right;",
        "}",

        "</style>",
        "</head>",

        "<body>",

        '<div class="container">',

        '<button class="refresh" onclick="loadDashboard()">Refresh</button>',

        "<h1>Dotopia Admin Dashboard</h1>",

        '<div class="subtitle">Memberships, payments and fulfillment</div>',

        '<div class="cards">',

        '<div class="card">',
        '<div class="card-title">Active Members</div>',
        '<div class="card-value" id="activeMembers">—</div>',
        "</div>",

        '<div class="card">',
        '<div class="card-title">Expiring Soon</div>',
        '<div class="card-value" id="expiringSoon">—</div>',
        "</div>",

        '<div class="card">',
        '<div class="card-title">Expired</div>',
        '<div class="card-value" id="expiredMembers">—</div>',
        "</div>",

        '<div class="card">',
        '<div class="card-title">Payments</div>',
        '<div class="card-value" id="payments">—</div>',
        "</div>",

        '<div class="card">',
        '<div class="card-title">Revenue</div>',
        '<div class="card-value" id="revenue">—</div>',
        "</div>",

        '<div class="card">',
        '<div class="card-title">Needs Recovery</div>',
        '<div class="card-value" id="recovery">—</div>',
        "</div>",

        "</div>",

        '<div class="section">',

        "<h2>Members</h2>",

        "<table>",

        "<thead>",
        "<tr>",
        "<th>ID</th>",
        "<th>Telegram User</th>",
        "<th>Status</th>",
        "<th>Start</th>",
        "<th>End</th>",
        "<th>Payment</th>",
        "<th>Action</th>",
        "</tr>",
        "</thead>",

        '<tbody id="membersTable">',
        '<tr><td colspan="7">Loading...</td></tr>',
        "</tbody>",

        "</table>",

        "</div>",

        '<div class="section">',

        "<h2>Payment History</h2>",

        "<table>",

        "<thead>",
        "<tr>",
        "<th>ID</th>",
        "<th>Telegram User</th>",
        "<th>Payment</th>",
        "<th>Amount</th>",
        "<th>Status</th>",
        "<th>Fulfillment</th>",
        "<th>Action</th>",
        "</tr>",
        "</thead>",

        '<tbody id="paymentsTable">',
        '<tr><td colspan="7">Loading...</td></tr>',
        "</tbody>",

        "</table>",

        "</div>",

        "</div>",

        "<script>",

        "async function loadDashboard(){",

        "try{",

        'const response=await fetch("/admin/api/dashboard");',

        "if(!response.ok)throw new Error('Dashboard request failed');",

        "const data=await response.json();",

        'document.getElementById("activeMembers").textContent=data.stats.activeMembers;',
        'document.getElementById("expiringSoon").textContent=data.stats.expiringSoon;',
        'document.getElementById("expiredMembers").textContent=data.stats.expiredMembers;',
        'document.getElementById("payments").textContent=data.stats.payments;',
        'document.getElementById("revenue").textContent="₹"+Number(data.stats.revenue||0).toLocaleString("en-IN");',
        'document.getElementById("recovery").textContent=data.stats.needsRecovery;',

        'const members=document.getElementById("membersTable");',

        "if(!data.members.length){",

        'members.innerHTML="<tr><td colspan=\\"7\\" class=\\"empty\\">No memberships found.</td></tr>";',

        "}else{",

        "members.innerHTML=data.members.map(function(member){",

        'const statusClass=member.status==="active"?"active":"expired";',

        "return '<tr>' +",
        "'<td>'+member.id+'</td>' +",
        "'<td>'+member.telegram_user_id+'</td>' +",
        "'<td><span class=\"status '+statusClass+'\">'+member.status+'</span></td>' +",
        "'<td>'+new Date(member.membership_start).toLocaleString()+'</td>' +",
        "'<td>'+new Date(member.membership_end).toLocaleString()+'</td>' +",
        "'<td>'+(member.payment_id||'—')+'</td>' +",
        "'<td>'+(member.status==='active' ? '<button onclick=\"resendAccess('+member.id+')\">Resend Access</button>' : '—')+'</td>' +",
        "'</tr>';",

        "}).join('');",

        "}",

        'const payments=document.getElementById("paymentsTable");',

        "if(!data.payments.length){",

        'payments.innerHTML="<tr><td colspan=\\"7\\" class=\\"empty\\">No payments found.</td></tr>";',

        "}else{",

        "payments.innerHTML=data.payments.map(function(payment){",

        'const fulfillmentClass=payment.fulfillment_status==="completed"?"completed":"processing";',

        "return '<tr>' +",
        "'<td>'+payment.id+'</td>' +",
        "'<td>'+payment.telegram_user_id+'</td>' +",
        "'<td>'+payment.payment_id+'</td>' +",
        "'<td>₹'+(Number(payment.amount_paise||0)/100).toLocaleString('en-IN')+'</td>' +",
        "'<td>'+(payment.payment_status||'—')+'</td>' +",
        "'<td><span class=\"status '+fulfillmentClass+'\">'+(payment.fulfillment_status||'—')+'</span></td>' +",
        "'<td>'+(payment.fulfillment_status==='processing' ? '<button onclick=\"retryPayment('+payment.id+')\">Retry</button>' : '—')+'</td>' +",
        "'</tr>';",

        "}).join('');",

        "}",

        "}catch(error){",

        "console.error(error);",

        'alert("Could not load dashboard. Check the server logs.");',

        "}",

        "}",

        "async function resendAccess(memberId){",

        'if(!confirm("Resend membership access?"))return;',

        "const response=await fetch(",
        '"/admin/api/members/"+memberId+"/resend",',
        "{method:'POST'}",
        ");",

        "const data=await response.json();",

        'alert(data.message||data.error||"Done");',

        "loadDashboard();",

        "}",

        "async function retryPayment(paymentId){",

        'if(!confirm("Retry this payment fulfillment?"))return;',

        "const response=await fetch(",
        '"/admin/api/payments/"+paymentId+"/retry",',
        "{method:'POST'}",
        ");",

        "const data=await response.json();",

        'alert(data.message||data.error||"Done");',

        "loadDashboard();",

        "}",

        "loadDashboard();",

        "setInterval(loadDashboard,60000);",

        "</script>",

        "</body>",
        "</html>"

    ].join("");

    res.send(html);

});


/* ==========================================
   ADMIN DASHBOARD API
   ========================================== */

app.get("/admin/api/dashboard", (req, res) => {

    try {

        const now = new Date().toISOString();

        const sevenDaysFromNow =
            new Date(
                Date.now() +
                7 * 24 * 60 * 60 * 1000
            ).toISOString();

        const activeMembers =
            db.prepare(`
                SELECT *
                FROM memberships
                WHERE status = 'active'
                AND membership_end > ?
                ORDER BY membership_end ASC
            `).all(now);

        const expiredMembers =
            db.prepare(`
                SELECT *
                FROM memberships
                WHERE status = 'expired'
                OR (
                    status = 'active'
                    AND membership_end <= ?
                )
                ORDER BY membership_end DESC
            `).all(now);

        const expiringSoon =
            db.prepare(`
                SELECT *
                FROM memberships
                WHERE status = 'active'
                AND membership_end > ?
                AND membership_end <= ?
                ORDER BY membership_end ASC
            `).all(
                now,
                sevenDaysFromNow
            );

        const payments =
            db.prepare(`
                SELECT *
                FROM payments
                ORDER BY id DESC
                LIMIT 200
            `).all();

        const members =
            db.prepare(`
                SELECT *
                FROM memberships
                ORDER BY id DESC
                LIMIT 200
            `).all();

        const revenue =
            db.prepare(`
                SELECT COALESCE(
                    SUM(amount_paise),
                    0
                ) AS total
                FROM payments
                WHERE payment_status = 'paid'
            `).get();

        const needsRecovery =
            db.prepare(`
                SELECT COUNT(*) AS count
                FROM payments
                WHERE fulfillment_status = 'processing'
            `).get();

        res.json({

            stats: {
                activeMembers: activeMembers.length,
                expiringSoon: expiringSoon.length,
                expiredMembers: expiredMembers.length,
                payments: payments.length,
                revenue: Number(revenue.total || 0) / 100,
                needsRecovery: Number(needsRecovery.count || 0)
            },

            members,
            payments

        });

    } catch (error) {

        console.error(
            "[ADMIN] Dashboard error:",
            error
        );

        res
            .status(500)
            .json({
                error: "Failed to load dashboard"
            });
    }

});


app.post(
    "/admin/api/members/:id/resend",
    async (req, res) => {

        try {

            const member =
                db.prepare(`
                    SELECT *
                    FROM memberships
                    WHERE id = ?
                `).get(req.params.id);

            if (!member) {

                return res
                    .status(404)
                    .json({
                        error: "Membership not found"
                    });
            }

            if (
                member.status !== "active" ||
                new Date(member.membership_end) <= new Date()
            ) {

                return res
                    .status(400)
                    .json({
                        error: "Membership is not active"
                    });
            }

            const invite =
                await bot.telegram.createChatInviteLink(
                    CHANNEL_ID,
                    {
                        member_limit: 1,
                        expire_date:
                            Math.floor(
                                new Date(
                                    member.membership_end
                                ).getTime() / 1000
                            )
                    }
                );

            db.prepare(`
                UPDATE memberships
                SET invite_link = ?
                WHERE id = ?
            `).run(
                invite.invite_link,
                member.id
            );

            await bot.telegram.sendMessage(
                member.telegram_user_id,
                [
                    "🔗 Membership Access",
                    "",
                    "Your private channel access link:",
                    "",
                    invite.invite_link,
                    "",
                    "This link is for your account only.",
                    "",
                    "Membership expires:",
                    new Date(
                        member.membership_end
                    ).toLocaleString("en-IN")
                ].join("\n")
            );

            res.json({
                message:
                    "Fresh access link sent successfully."
            });

        } catch (error) {

            console.error(
                "[ADMIN] Resend access error:",
                error
            );

            res
                .status(500)
                .json({
                    error:
                        "Failed to resend access"
                });
        }

    }
);


app.post(
    "/admin/api/payments/:paymentId/retry",
    async (req, res) => {

        try {

            const payment =
                db.prepare(`
                    SELECT *
                    FROM payments
                    WHERE id = ?
                `).get(req.params.paymentId);

            if (!payment) {

                return res
                    .status(404)
                    .json({
                        error: "Payment not found"
                    });
            }

            if (
                payment.fulfillment_status ===
                "completed"
            ) {

                return res.json({
                    message:
                        "Payment is already completed."
                });
            }

            await fulfillPayment(payment);

            res.json({
                message:
                    "Payment fulfillment completed."
            });

        } catch (error) {

            console.error(
                "[ADMIN] Retry fulfillment error:",
                error
            );

            res
                .status(500)
                .json({
                    error:
                        "Fulfillment failed. Check server logs."
                });
        }

    }
);

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
    