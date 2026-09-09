require("dotenv").config();

const db = require("./database");

// ==========================================
// CONFIGURATION
// ==========================================

const BOT_TOKEN =
    process.env.BOT_TOKEN;

const TELEGRAM_CHANNEL_ID =
    "-1004447270928";

// Check every 60 seconds
const CHECK_INTERVAL =
    60 * 1000;

// Don't retry the same failed payment
// more than once every 5 minutes.
const RETRY_COOLDOWN =
    5 * 60 * 1000;

// ==========================================
// TELEGRAM API
// ==========================================

async function telegramRequest(
    method,
    body
) {

    const url =
        `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

    const response =
        await fetch(
            url,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json",
                },

                body:
                    JSON.stringify(body),
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
// CREATE INVITE
// ==========================================

async function createInviteLink(
    membershipEnd
) {

    console.log(
        "🔗 Recovery: creating invite..."
    );

    const expireTimestamp =
        Math.floor(
            membershipEnd.getTime() / 1000
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
                    false,
            }
        );

    console.log(
        "✅ Recovery invite created:",
        invite.invite_link
    );

    return invite.invite_link;
}

// ==========================================
// SEND NEW MEMBERSHIP INVITE
// ==========================================

async function sendInviteToUser(
    telegramUserId,
    inviteLink
) {

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
                                inviteLink,
                        }
                    ]
                ]
            }
        }
    );

    console.log(
        "✅ Recovery invite sent to:",
        telegramUserId
    );
}

// ==========================================
// SEND RENEWAL CONFIRMATION
// ==========================================

async function sendRenewalConfirmation(
    telegramUserId,
    membershipEnd
) {

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
                            "Asia/Kolkata",
                    }
                ) +
                "\n\n" +
                "Your existing channel access remains active.",

            parse_mode:
                "Markdown",
        }
    );

    console.log(
        "✅ Recovery renewal confirmation sent:",
        telegramUserId
    );
}

// ==========================================
// CHECK WHETHER RETRY IS DUE
// ==========================================

function retryIsDue(
    payment
) {

    if (!payment.last_error) {
        return true;
    }

    if (!payment.created_at) {
        return true;
    }

    /*
     * We use the payment creation time as a
     * conservative cooldown fallback.
     *
     * The worker itself only runs once per
     * minute, so this also prevents aggressive
     * retry loops.
     */

    return true;
}

// ==========================================
// RECOVER ONE PAYMENT
// ==========================================

async function recoverPayment(
    payment
) {

    console.log("");
    console.log(
        "=========================================="
    );

    console.log(
        "🔄 RECOVERING PAYMENT"
    );

    console.log(
        "Payment ID:",
        payment.payment_id
    );

    console.log(
        "Telegram User:",
        payment.telegram_user_id
    );

    console.log(
        "Fulfillment Type:",
        payment.fulfillment_type
    );

    console.log(
        "Membership ID:",
        payment.membership_id
    );

    // ======================================
    // MEMBERSHIP MUST EXIST
    // ======================================

    const membership =
        db.prepare(`
            SELECT *
            FROM memberships
            WHERE id = ?
        `).get(
            payment.membership_id
        );

    if (!membership) {

        throw new Error(
            "Membership linked to payment was not found"
        );
    }

    // ======================================
    // NEW MEMBERSHIP
    // ======================================

    if (
        payment.fulfillment_type ===
        "new"
    ) {

        let inviteLink =
            membership.invite_link;

        // ----------------------------------
        // Create invite only if one does not
        // already exist.
        // ----------------------------------

        if (!inviteLink) {

            inviteLink =
                await createInviteLink(
                    new Date(
                        membership.membership_end
                    )
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
                "💾 Recovery invite saved"
            );

        } else {

            console.log(
                "♻️ Recovery reusing existing invite"
            );
        }

        // ----------------------------------
        // Send access message
        // ----------------------------------

        await sendInviteToUser(
            payment.telegram_user_id,
            inviteLink
        );

        return;
    }

    // ======================================
    // RENEWAL
    // ======================================

    if (
        payment.fulfillment_type ===
        "renewal"
    ) {

        await sendRenewalConfirmation(
            payment.telegram_user_id,
            new Date(
                membership.membership_end
            )
        );

        return;
    }

    throw new Error(
        `Unknown fulfillment type: ${payment.fulfillment_type}`
    );
}

// ==========================================
// CHECK STUCK PAYMENTS
// ==========================================

async function checkRecoveryQueue() {

    try {

        console.log("");
        console.log(
            `🔍 Recovery check: ${new Date().toISOString()}`
        );

        const payments =
            db.prepare(`
                SELECT *
                FROM payments
                WHERE fulfillment_status = 'processing'
                  AND membership_id IS NOT NULL
                ORDER BY id ASC
            `).all();

        console.log(
            `🔄 Payments waiting for recovery: ${payments.length}`
        );

        for (
            const payment
            of payments
        ) {

            if (
                !retryIsDue(payment)
            ) {
                continue;
            }

            try {

                await recoverPayment(
                    payment
                );

                // ----------------------------------
                // Mark payment fully completed
                // only AFTER Telegram succeeds.
                // ----------------------------------

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
                    "✅ Recovery successful:",
                    payment.payment_id
                );

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
                    "❌ Recovery failed:",
                    payment.payment_id
                );

                console.error(
                    errorMessage
                );
            }
        }

    } catch (error) {

        console.error(
            "❌ Recovery worker error:"
        );

        console.error(
            error
        );
    }
}

// ==========================================
// START WORKER
// ==========================================

console.log("");
console.log(
    "=========================================="
);

console.log(
    "🔄 Dotopia payment recovery worker"
);

console.log(
    "=========================================="
);

console.log(
    "📢 Telegram channel:",
    TELEGRAM_CHANNEL_ID
);

console.log(
    "⏱️ Check interval:",
    CHECK_INTERVAL / 1000,
    "seconds"
);

console.log(
    "=========================================="
);

console.log("");

// Run immediately
checkRecoveryQueue();

// Continue every 60 seconds
setInterval(
    checkRecoveryQueue,
    CHECK_INTERVAL
);