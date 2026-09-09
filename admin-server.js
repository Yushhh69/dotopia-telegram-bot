require("dotenv").config();

const express = require("express");

const db = require("./database");

const app = express();

const PORT = 3001;

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD;

const TELEGRAM_BOT_TOKEN =
    process.env.BOT_TOKEN;

const TELEGRAM_CHANNEL_ID =
    "-1004447270928";

// ==========================================
// SECURITY CHECKS
// ==========================================

if (!ADMIN_PASSWORD) {

    console.error(
        "❌ ADMIN_PASSWORD is missing from .env"
    );

    process.exit(1);
}

if (!TELEGRAM_BOT_TOKEN) {

    console.error(
        "❌ BOT_TOKEN is missing from .env"
    );

    process.exit(1);
}

// ==========================================
// BODY PARSER
// ==========================================

app.use(
    express.urlencoded({
        extended: false
    })
);

// ==========================================
// ADMIN AUTHENTICATION
// ==========================================

function requireAdmin(
    req,
    res,
    next
) {

    const authorization =
        req.headers.authorization;

    if (!authorization) {

        res.setHeader(
            "WWW-Authenticate",
            'Basic realm="Dotopia Admin"'
        );

        return res
            .status(401)
            .send(
                "Authentication required"
            );
    }

    const encoded =
        authorization.replace(
            "Basic ",
            ""
        );

    let decoded;

    try {

        decoded =
            Buffer
                .from(
                    encoded,
                    "base64"
                )
                .toString(
                    "utf8"
                );

    } catch (error) {

        return res
            .status(401)
            .send(
                "Invalid authentication"
            );
    }

    const separator =
        decoded.indexOf(":");

    if (
        separator === -1
    ) {

        return res
            .status(401)
            .send(
                "Invalid authentication"
            );
    }

    const username =
        decoded.slice(
            0,
            separator
        );

    const password =
        decoded.slice(
            separator + 1
        );

    if (
        username !== "admin" ||
        password !== ADMIN_PASSWORD
    ) {

        res.setHeader(
            "WWW-Authenticate",
            'Basic realm="Dotopia Admin"'
        );

        return res
            .status(401)
            .send(
                "Invalid username or password"
            );
    }

    next();
}

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
// CREATE INVITE LINK
// ==========================================

async function createInviteLink(
    membershipEnd
) {

    const end =
        new Date(
            membershipEnd
        );

    const now =
        new Date();

    if (
        end <= now
    ) {

        throw new Error(
            "Membership has already expired"
        );
    }

    const expireTimestamp =
        Math.floor(
            end.getTime() / 1000
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

    return invite.invite_link;
}

// ==========================================
// SEND ACCESS MESSAGE
// ==========================================

async function sendAccessMessage(
    userId,
    inviteLink
) {

    await telegramRequest(
        "sendMessage",
        {
            chat_id:
                userId,

            text:
                "🔐 *Dotopia Channel Access*\n\n" +
                "Your Dotopia membership is active.\n\n" +
                "Use the button below to join the private channel.",

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
}

// ==========================================
// SEND RENEWAL CONFIRMATION
// ==========================================

async function sendRenewalConfirmation(
    userId,
    membershipEnd
) {

    await telegramRequest(
        "sendMessage",
        {
            chat_id:
                userId,

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
                "Your existing channel access remains active.",

            parse_mode:
                "Markdown"
        }
    );
}

// ==========================================
// RESEND ACCESS
// ==========================================

async function resendAccess(
    membershipId
) {

    const membership =
        db.prepare(`
            SELECT *
            FROM memberships
            WHERE id = ?
              AND status = 'active'
            LIMIT 1
        `).get(
            membershipId
        );

    if (!membership) {

        throw new Error(
            "Active membership not found"
        );
    }

    const membershipEnd =
        new Date(
            membership.membership_end
        );

    if (
        membershipEnd <= new Date()
    ) {

        throw new Error(
            "This membership has already expired"
        );
    }

    console.log(
        "📨 Admin resend access:",
        membership.telegram_user_id
    );

    const inviteLink =
        await createInviteLink(
            membership.membership_end
        );

    db.prepare(`
        UPDATE memberships
        SET invite_link = ?
        WHERE id = ?
          AND status = 'active'
    `).run(
        inviteLink,
        membership.id
    );

    await sendAccessMessage(
        membership.telegram_user_id,
        inviteLink
    );

    console.log(
        "✅ Access resent successfully"
    );

    return inviteLink;
}

// ==========================================
// RETRY FULFILLMENT
// ==========================================
//
// Used only for payments whose fulfillment
// is still "processing".
//
// IMPORTANT:
// This does not create another payment or
// another membership. It retries the existing
// payment's Telegram fulfillment.
// ==========================================

async function retryFulfillment(
    paymentId
) {

    const payment =
        db.prepare(`
            SELECT *
            FROM payments
            WHERE payment_id = ?
            LIMIT 1
        `).get(
            paymentId
        );

    if (!payment) {

        throw new Error(
            "Payment not found"
        );
    }

    if (
        payment.fulfillment_status !==
        "processing"
    ) {

        throw new Error(
            `Payment is not waiting for recovery. Current status: ${payment.fulfillment_status}`
        );
    }

    if (!payment.membership_id) {

        throw new Error(
            "Payment has no linked membership"
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
            "Linked membership not found"
        );
    }

    const userId =
        payment.telegram_user_id;

    console.log("");
    console.log(
        "=========================================="
    );
    console.log(
        "🔄 ADMIN FULFILLMENT RETRY"
    );
    console.log(
        "=========================================="
    );
    console.log(
        "Payment:",
        payment.payment_id
    );
    console.log(
        "Telegram User:",
        userId
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

        // ======================================
        // NEW MEMBERSHIP
        // ======================================

        if (
            payment.fulfillment_type ===
            "new"
        ) {

            const membershipEnd =
                new Date(
                    membership.membership_end
                );

            if (
                membershipEnd <= new Date()
            ) {

                throw new Error(
                    "Membership has already expired"
                );
            }

            let inviteLink =
                membership.invite_link;

            // ----------------------------------
            // Reuse an existing invite when one
            // was already created.
            // ----------------------------------

            if (!inviteLink) {

                console.log(
                    "🔗 Creating recovery invite..."
                );

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

            } else {

                console.log(
                    "♻️ Reusing existing invite"
                );
            }

            await sendAccessMessage(
                userId,
                inviteLink
            );
        }

        // ======================================
        // RENEWAL
        // ======================================

        else if (
            payment.fulfillment_type ===
            "renewal"
        ) {

            await sendRenewalConfirmation(
                userId,
                new Date(
                    membership.membership_end
                )
            );

        } else {

            throw new Error(
                `Unknown fulfillment type: ${payment.fulfillment_type}`
            );
        }

        // ======================================
        // SUCCESS
        // ======================================

        db.prepare(`
            UPDATE payments
            SET
                fulfillment_status = 'completed',
                last_error = NULL
            WHERE payment_id = ?
        `).run(
            payment.payment_id
        );

        console.log(
            "✅ Recovery successful"
        );

        console.log(
            "=========================================="
        );

        return true;

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
            "❌ Recovery attempt failed:"
        );

        console.error(
            errorMessage
        );

        throw error;
    }
}

// ==========================================
// HEALTH
// ==========================================

app.get(
    "/health",
    (req, res) => {

        res.json({
            status:
                "ok",

            service:
                "Dotopia Admin",

            time:
                new Date().toISOString()
        });
    }
);

// ==========================================
// DASHBOARD DATA
// ==========================================

function getDashboardData() {

    const now =
        new Date();

    const sevenDaysFromNow =
        new Date(
            now
        );

    sevenDaysFromNow.setDate(
        sevenDaysFromNow.getDate() + 7
    );

    const activeMembers =
        db.prepare(`
            SELECT COUNT(*) AS count
            FROM memberships
            WHERE status = 'active'
              AND membership_end > ?
        `).get(
            now.toISOString()
        ).count;

    const expiredMembers =
        db.prepare(`
            SELECT COUNT(*) AS count
            FROM memberships
            WHERE status = 'expired'
        `).get().count;

    const expiringSoon =
        db.prepare(`
            SELECT COUNT(*) AS count
            FROM memberships
            WHERE status = 'active'
              AND membership_end > ?
              AND membership_end <= ?
        `).get(
            now.toISOString(),
            sevenDaysFromNow.toISOString()
        ).count;

    const totalPayments =
        db.prepare(`
            SELECT COUNT(*) AS count
            FROM payments
            WHERE payment_status = 'paid'
        `).get().count;

    const revenue =
        db.prepare(`
            SELECT
                COALESCE(
                    SUM(amount_paise),
                    0
                ) AS amount
            FROM payments
            WHERE payment_status = 'paid'
        `).get().amount;

    const processingPayments =
        db.prepare(`
            SELECT COUNT(*) AS count
            FROM payments
            WHERE fulfillment_status = 'processing'
        `).get().count;

    return {
        activeMembers,
        expiredMembers,
        expiringSoon,
        totalPayments,
        revenue,
        processingPayments
    };
}

// ==========================================
// MEMBERS
// ==========================================

function getMembers() {

    return db.prepare(`
        SELECT
            m.id,
            m.telegram_user_id,
            m.payment_id,
            m.amount_paise,
            m.membership_start,
            m.membership_end,
            m.status,
            m.invite_link,
            m.reminder_7_sent,
            m.reminder_1_sent,
            m.expiry_notification_sent,
            m.created_at,

            p.fulfillment_status,
            p.fulfillment_type

        FROM memberships m

        LEFT JOIN payments p
            ON p.payment_id = m.payment_id

        ORDER BY
            CASE
                WHEN m.status = 'active'
                THEN 0
                ELSE 1
            END,

            m.membership_end ASC
    `).all();
}

// ==========================================
// PAYMENTS
// ==========================================

function getPayments() {

    return db.prepare(`
        SELECT
            id,
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
            last_error,
            created_at

        FROM payments

        ORDER BY id DESC
    `).all();
}

// ==========================================
// FORMAT MONEY
// ==========================================

function formatMoney(
    paise
) {

    return (
        "₹" +
        (
            Number(paise) / 100
        ).toLocaleString(
            "en-IN",
            {
                maximumFractionDigits:
                    2
            }
        )
    );
}

// ==========================================
// FORMAT DATE
// ==========================================

function formatDate(
    value
) {

    if (!value) {
        return "—";
    }

    const date =
        new Date(
            value
        );

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return "—";
    }

    return date.toLocaleString(
        "en-IN",
        {
            dateStyle:
                "medium",

            timeStyle:
                "short",

            timeZone:
                "Asia/Kolkata"
        }
    );
}

// ==========================================
// ESCAPE HTML
// ==========================================

function escapeHtml(
    value
) {

    return String(
        value ?? ""
    )
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}

// ==========================================
// STATUS BADGE
// ==========================================

function statusBadge(
    status
) {

    const safe =
        escapeHtml(
            status
        );

    let className =
        "badge";

    if (
        status === "active" ||
        status === "completed"
    ) {

        className +=
            " success";

    } else if (
        status === "processing"
    ) {

        className +=
            " warning";

    } else if (
        status === "expired" ||
        status === "superseded"
    ) {

        className +=
            " muted";
    }

    return `
        <span class="${className}">
            ${safe}
        </span>
    `;
}

// ==========================================
// RENDER DASHBOARD
// ==========================================

function renderDashboard(
    data,
    members,
    payments,
    message = null
) {

    const memberRows =
        members.length
            ? members.map(
                (member) => {

                    const isActive =
                        member.status ===
                        "active";

                    return `
                    <tr>

                        <td>
                            <strong>
                                ${escapeHtml(
                                    member.telegram_user_id
                                )}
                            </strong>
                        </td>

                        <td>
                            ${statusBadge(
                                member.status
                            )}
                        </td>

                        <td>
                            ${formatDate(
                                member.membership_start
                            )}
                        </td>

                        <td>
                            ${formatDate(
                                member.membership_end
                            )}
                        </td>

                        <td>
                            ${formatMoney(
                                member.amount_paise
                            )}
                        </td>

                        <td>
                            ${
                                member.fulfillment_type
                                    ? statusBadge(
                                        member.fulfillment_type
                                    )
                                    : "—"
                            }
                        </td>

                        <td>
                            <code>
                                ${escapeHtml(
                                    member.payment_id ||
                                    "—"
                                )}
                            </code>
                        </td>

                        <td>

                            ${
                                isActive
                                    ? `
                                    <form
                                        method="POST"
                                        action="/admin/resend-access"
                                        onsubmit="return confirm('Resend a fresh private-channel invite to this member?');"
                                    >

                                        <input
                                            type="hidden"
                                            name="membership_id"
                                            value="${member.id}"
                                        >

                                        <button
                                            type="submit"
                                            class="action-button"
                                        >
                                            📨 Resend Access
                                        </button>

                                    </form>
                                    `
                                    : `
                                    <span class="disabled-action">
                                        Not available
                                    </span>
                                    `
                            }

                        </td>

                    </tr>
                    `;
                }
            ).join("")
            : `
                <tr>
                    <td
                        colspan="8"
                        class="empty"
                    >
                        No memberships found.
                    </td>
                </tr>
            `;

    const paymentRows =
        payments.length
            ? payments.map(
                (payment) => {

                    const needsRecovery =
                        payment.fulfillment_status ===
                        "processing";

                    return `
                    <tr>

                        <td>
                            <code>
                                ${escapeHtml(
                                    payment.payment_id
                                )}
                            </code>
                        </td>

                        <td>
                            ${escapeHtml(
                                payment.telegram_user_id
                            )}
                        </td>

                        <td>
                            ${formatMoney(
                                payment.amount_paise
                            )}
                        </td>

                        <td>
                            ${statusBadge(
                                payment.payment_status
                            )}
                        </td>

                        <td>
                            ${statusBadge(
                                payment.fulfillment_status
                            )}
                        </td>

                        <td>
                            ${
                                payment.fulfillment_type
                                    ? statusBadge(
                                        payment.fulfillment_type
                                    )
                                    : "—"
                            }
                        </td>

                        <td>
                            ${formatDate(
                                payment.created_at
                            )}
                        </td>

                        <td>

                            ${
                                needsRecovery
                                    ? `
                                    <form
                                        method="POST"
                                        action="/admin/retry-fulfillment"
                                        onsubmit="return confirm('Retry Telegram fulfillment for this payment?');"
                                    >

                                        <input
                                            type="hidden"
                                            name="payment_id"
                                            value="${escapeHtml(
                                                payment.payment_id
                                            )}"
                                        >

                                        <button
                                            type="submit"
                                            class="retry-button"
                                        >
                                            🔄 Retry Fulfillment
                                        </button>

                                    </form>

                                    ${
                                        payment.last_error
                                            ? `
                                            <div class="error-detail">
                                                ${escapeHtml(
                                                    payment.last_error
                                                )}
                                            </div>
                                            `
                                            : ""
                                    }
                                    `
                                    : `
                                    <span class="ok-text">
                                        ✓ Completed
                                    </span>
                                    `
                            }

                        </td>

                    </tr>
                    `;
                }
            ).join("")
            : `
                <tr>
                    <td
                        colspan="8"
                        class="empty"
                    >
                        No payments found.
                    </td>
                </tr>
            `;

    const notification =
        message
            ? `
                <div class="notification ${message.type}">
                    ${escapeHtml(
                        message.text
                    )}
                </div>
            `
            : "";

    return `
<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<meta
    http-equiv="refresh"
    content="60"
>

<title>Dotopia Admin</title>

<style>

* {
    box-sizing:
        border-box;
}

body {

    margin:
        0;

    background:
        #0b0b0d;

    color:
        #f5f5f7;

    font-family:
        Arial,
        Helvetica,
        sans-serif;

    line-height:
        1.5;
}

.container {

    max-width:
        1500px;

    margin:
        0 auto;

    padding:
        35px 25px 60px;
}

.header {

    display:
        flex;

    justify-content:
        space-between;

    align-items:
        center;

    margin-bottom:
        25px;
}

.brand {

    font-size:
        24px;

    font-weight:
        700;

    letter-spacing:
        .14em;
}

.subtitle {

    color:
        #92929c;

    font-size:
        13px;
}

.notification {

    padding:
        15px 18px;

    margin-bottom:
        25px;

    border-radius:
        12px;

    font-size:
        13px;
}

.notification.success {

    background:
        #132719;

    border:
        1px solid
        #245b31;

    color:
        #8ee09d;
}

.notification.error {

    background:
        #2a1515;

    border:
        1px solid
        #632c2c;

    color:
        #ff9c9c;
}

.stats {

    display:
        grid;

    grid-template-columns:
        repeat(
            6,
            1fr
        );

    gap:
        14px;

    margin-bottom:
        45px;
}

.stat {

    background:
        #141418;

    border:
        1px solid
        #2b2b33;

    border-radius:
        16px;

    padding:
        22px;
}

.stat-label {

    color:
        #8e8e98;

    font-size:
        12px;

    text-transform:
        uppercase;

    letter-spacing:
        .08em;
}

.stat-value {

    font-size:
        28px;

    font-weight:
        700;

    margin-top:
        8px;
}

.section {

    margin-top:
        35px;
}

.section-title {

    font-size:
        22px;

    margin-bottom:
        14px;
}

.table-wrap {

    overflow-x:
        auto;

    border:
        1px solid
        #2b2b33;

    border-radius:
        16px;

    background:
        #141418;
}

table {

    width:
        100%;

    border-collapse:
        collapse;

    min-width:
        1200px;
}

th,
td {

    padding:
        15px;

    text-align:
        left;

    border-bottom:
        1px solid
        #24242b;

    font-size:
        13px;

    white-space:
        nowrap;
}

th {

    color:
        #888891;

    font-size:
        11px;

    text-transform:
        uppercase;

    letter-spacing:
        .07em;
}

tr:last-child td {

    border-bottom:
        none;
}

code {

    font-family:
        Consolas,
        monospace;

    color:
        #c6c6ce;

    font-size:
        12px;
}

.badge {

    display:
        inline-block;

    padding:
        4px 9px;

    border-radius:
        999px;

    font-size:
        11px;

    border:
        1px solid
        #383840;
}

.badge.success {

    background:
        #132719;

    border-color:
        #245b31;

    color:
        #8ee09d;
}

.badge.warning {

    background:
        #302612;

    border-color:
        #624b20;

    color:
        #f1c66d;
}

.badge.muted {

    background:
        #1d1d22;

    border-color:
        #34343c;

    color:
        #9999a3;
}

.action-button,
.retry-button {

    border:
        1px solid
        #3d7775;

    background:
        #14302f;

    color:
        #8ee5e1;

    padding:
        8px 12px;

    border-radius:
        8px;

    cursor:
        pointer;

    font-size:
        12px;

    font-weight:
        600;
}

.action-button:hover,
.retry-button:hover {

    background:
        #1b403e;
}

.retry-button {

    border-color:
        #765c2a;

    background:
        #302612;

    color:
        #f1c66d;
}

.retry-button:hover {

    background:
        #3d3018;
}

.disabled-action {

    color:
        #666670;

    font-size:
        12px;
}

.warning-text {

    color:
        #f1c66d;

    font-size:
        12px;
}

.ok-text {

    color:
        #8ee09d;

    font-size:
        12px;
}

.error-detail {

    max-width:
        350px;

    margin-top:
        8px;

    color:
        #ff9c9c;

    font-size:
        11px;

    white-space:
        normal;

    line-height:
        1.4;
}

.empty {

    color:
        #777781;

    text-align:
        center;

    padding:
        35px;
}

.notice {

    margin-top:
        25px;

    padding:
        16px 18px;

    background:
        #17171c;

    border:
        1px solid
        #2b2b33;

    border-radius:
        12px;

    color:
        #96969f;

    font-size:
        13px;
}

@media (
    max-width: 1100px
) {

    .stats {

        grid-template-columns:
            repeat(
                3,
                1fr
            );
    }
}

@media (
    max-width: 600px
) {

    .stats {

        grid-template-columns:
            repeat(
                2,
                1fr
            );
    }

    .container {

        padding:
            22px 14px 45px;
    }
}

</style>

</head>

<body>

<div class="container">

    <div class="header">

        <div>

            <div class="brand">
                DOTOPIA
            </div>

            <div class="subtitle">
                Private Admin Dashboard
            </div>

        </div>

        <div class="subtitle">
            Auto-refresh: 60s
        </div>

    </div>

    ${notification}

    <div class="stats">

        <div class="stat">

            <div class="stat-label">
                Active Members
            </div>

            <div class="stat-value">
                ${data.activeMembers}
            </div>

        </div>

        <div class="stat">

            <div class="stat-label">
                Expiring Soon
            </div>

            <div class="stat-value">
                ${data.expiringSoon}
            </div>

        </div>

        <div class="stat">

            <div class="stat-label">
                Expired
            </div>

            <div class="stat-value">
                ${data.expiredMembers}
            </div>

        </div>

        <div class="stat">

            <div class="stat-label">
                Payments
            </div>

            <div class="stat-value">
                ${data.totalPayments}
            </div>

        </div>

        <div class="stat">

            <div class="stat-label">
                Revenue
            </div>

            <div class="stat-value">
                ${formatMoney(
                    data.revenue
                )}
            </div>

        </div>

        <div class="stat">

            <div class="stat-label">
                Needs Recovery
            </div>

            <div class="stat-value">
                ${data.processingPayments}
            </div>

        </div>

    </div>

    <section class="section">

        <h2 class="section-title">
            Members
        </h2>

        <div class="table-wrap">

            <table>

                <thead>

                    <tr>

                        <th>
                            Telegram User
                        </th>

                        <th>
                            Status
                        </th>

                        <th>
                            Start
                        </th>

                        <th>
                            Expiry
                        </th>

                        <th>
                            Amount
                        </th>

                        <th>
                            Type
                        </th>

                        <th>
                            Payment
                        </th>

                        <th>
                            Actions
                        </th>

                    </tr>

                </thead>

                <tbody>

                    ${memberRows}

                </tbody>

            </table>

        </div>

    </section>

    <section class="section">

        <h2 class="section-title">
            Payment History
        </h2>

        <div class="table-wrap">

            <table>

                <thead>

                    <tr>

                        <th>
                            Payment ID
                        </th>

                        <th>
                            Telegram User
                        </th>

                        <th>
                            Amount
                        </th>

                        <th>
                            Payment
                        </th>

                        <th>
                            Fulfillment
                        </th>

                        <th>
                            Type
                        </th>

                        <th>
                            Created
                        </th>

                        <th>
                            Actions
                        </th>

                    </tr>

                </thead>

                <tbody>

                    ${paymentRows}

                </tbody>

            </table>

        </div>

    </section>

    <div class="notice">

        🔒 Local admin dashboard.
        Resend Access creates a new one-use
        private-channel invite for an active
        membership.

        <br><br>

        🔄 Retry Fulfillment is available only
        for payments currently stuck in
        <strong>processing</strong>.

    </div>

</div>

</body>

</html>
`;
}

// ==========================================
// ADMIN — RESEND ACCESS
// ==========================================

app.post(
    "/admin/resend-access",
    requireAdmin,
    async (
        req,
        res
    ) => {

        const membershipId =
            Number(
                req.body.membership_id
            );

        if (
            !Number.isInteger(
                membershipId
            ) ||
            membershipId <= 0
        ) {

            return res
                .status(400)
                .send(
                    "Invalid membership ID"
                );
        }

        try {

            await resendAccess(
                membershipId
            );

            res.redirect(
                "/?message=access_sent"
            );

        } catch (error) {

            console.error(
                "❌ Admin resend access failed:"
            );

            console.error(
                error
            );

            res.redirect(
                "/?message=access_failed"
            );
        }
    }
);

// ==========================================
// ADMIN — RETRY FULFILLMENT
// ==========================================

app.post(
    "/admin/retry-fulfillment",
    requireAdmin,
    async (
        req,
        res
    ) => {

        const paymentId =
            String(
                req.body.payment_id ||
                ""
            ).trim();

        if (!paymentId) {

            return res
                .status(400)
                .send(
                    "Invalid payment ID"
                );
        }

        try {

            await retryFulfillment(
                paymentId
            );

            res.redirect(
                "/?message=recovery_success"
            );

        } catch (error) {

            console.error(
                "❌ Admin fulfillment retry failed:"
            );

            console.error(
                error
            );

            res.redirect(
                "/?message=recovery_failed"
            );
        }
    }
);

// ==========================================
// DASHBOARD
// ==========================================

app.get(
    "/",
    requireAdmin,
    (req, res) => {

        const data =
            getDashboardData();

        const members =
            getMembers();

        const payments =
            getPayments();

        let message =
            null;

        if (
            req.query.message ===
            "access_sent"
        ) {

            message = {
                type:
                    "success",

                text:
                    "✅ Fresh channel access invite sent successfully."
            };

        } else if (
            req.query.message ===
            "access_failed"
        ) {

            message = {
                type:
                    "error",

                text:
                    "❌ Could not resend access. Check the admin-server terminal for the error."
            };

        } else if (
            req.query.message ===
            "recovery_success"
        ) {

            message = {
                type:
                    "success",

                text:
                    "✅ Fulfillment retry completed successfully."
            };

        } else if (
            req.query.message ===
            "recovery_failed"
        ) {

            message = {
                type:
                    "error",

                text:
                    "❌ Fulfillment retry failed. The payment remains in recovery. Check the admin-server terminal."
            };
        }

        const html =
            renderDashboard(
                data,
                members,
                payments,
                message
            );

        res
            .type("html")
            .send(
                html
            );
    }
);

// ==========================================
// START SERVER
// ==========================================

app.listen(
    PORT,
    "127.0.0.1",
    () => {

        console.log("");

        console.log(
            "=========================================="
        );

        console.log(
            "📊 Dotopia admin dashboard"
        );

        console.log(
            "=========================================="
        );

        console.log(
            `🌐 http://127.0.0.1:${PORT}`
        );

        console.log(
            "🔒 Local access only"
        );

        console.log(
            "📨 Resend Access: enabled"
        );

        console.log(
            "🔄 Retry Fulfillment: enabled"
        );

        console.log(
            "=========================================="
        );

        console.log("");
    }
);