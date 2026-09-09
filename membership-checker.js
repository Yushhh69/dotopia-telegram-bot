require("dotenv").config();

const db = require("./database");

const BOT_TOKEN = process.env.BOT_TOKEN;

const TELEGRAM_CHANNEL_ID = "-1004447270928";

const CHECK_INTERVAL = 60 * 1000;

// ==========================================
// TELEGRAM API
// ==========================================

async function telegramRequest(method, body) {

    const url =
        `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

    const response =
        await fetch(
            url,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
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
// GET FRESH MEMBERSHIP
// ==========================================

function getMembershipById(
    membershipId
) {

    return db.prepare(`
        SELECT *
        FROM memberships
        WHERE id = ?
        LIMIT 1
    `).get(
        membershipId
    );
}

// ==========================================
// SEND MESSAGE
// ==========================================

async function sendMessage(
    userId,
    text,
    showRenewButton = false
) {

    const keyboard =
        showRenewButton
            ? {
                inline_keyboard: [
                    [
                        {
                            text:
                                "🔄 Renew Membership",

                            callback_data:
                                "renew_membership"
                        }
                    ]
                ]
            }
            : undefined;

    await telegramRequest(
        "sendMessage",
        {
            chat_id:
                userId,

            text:
                text,

            reply_markup:
                keyboard
        }
    );

    console.log(
        "📨 Message sent to:",
        userId
    );
}

// ==========================================
// CREATE PRIVATE CHANNEL INVITE
// ==========================================

async function createInviteLink(
    membershipEnd
) {

    console.log(
        "🔗 Creating fresh private channel invite..."
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
        "✅ Fresh invite created:",
        invite.invite_link
    );

    return invite.invite_link;
}

// ==========================================
// SEND ACCESS FOR RESTORED MEMBERSHIP
// ==========================================

async function sendRestoredAccess(
    userId,
    inviteLink
) {

    await telegramRequest(
        "sendMessage",
        {
            chat_id:
                userId,

            text:
                "🎉 *Your Dotopia membership is active!*\n\n" +
                "Your membership was renewed successfully.\n\n" +
                "Your private-channel access has been restored.\n\n" +
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
        "✅ Restored access message sent to:",
        userId
    );
}

// ==========================================
// REMOVE FROM CHANNEL
// ==========================================

async function removeFromChannel(
    userId
) {

    console.log(
        "🚫 Removing expired member:",
        userId
    );

    await telegramRequest(
        "banChatMember",
        {
            chat_id:
                TELEGRAM_CHANNEL_ID,

            user_id:
                Number(userId),

            revoke_messages:
                false
        }
    );

    await telegramRequest(
        "unbanChatMember",
        {
            chat_id:
                TELEGRAM_CHANNEL_ID,

            user_id:
                Number(userId),

            only_if_banned:
                true
        }
    );

    console.log(
        "✅ Expired member removed:",
        userId
    );
}

// ==========================================
// CHECK 7-DAY REMINDER
// ==========================================

async function processSevenDayReminder(
    membership
) {

    const freshMembership =
        getMembershipById(
            membership.id
        );

    if (
        !freshMembership ||
        freshMembership.status !== "active"
    ) {
        return;
    }

    const now =
        new Date();

    const end =
        new Date(
            freshMembership.membership_end
        );

    const sevenDaysBefore =
        new Date(
            end
        );

    sevenDaysBefore.setDate(
        sevenDaysBefore.getDate() - 7
    );

    if (
        now < sevenDaysBefore ||
        now >= end ||
        freshMembership.reminder_7_sent !== 0
    ) {
        return;
    }

    const userId =
        freshMembership.telegram_user_id;

    console.log(
        "⏰ Sending 7-day renewal reminder:",
        userId
    );

    await sendMessage(
        userId,

        "⏰ Your Dotopia membership expires in 7 days.\n\n" +
        "Renew now to continue accessing the private Dotopia channel without interruption.",

        true
    );

    // ======================================
    // Mark ONLY if the same membership is
    // still active and its expiry is unchanged.
    // ======================================

    const result =
        db.prepare(`
            UPDATE memberships
            SET reminder_7_sent = 1
            WHERE id = ?
              AND status = 'active'
              AND membership_end = ?
              AND reminder_7_sent = 0
        `).run(
            freshMembership.id,
            freshMembership.membership_end
        );

    if (
        result.changes === 1
    ) {

        console.log(
            "✅ 7-day reminder marked as sent:",
            userId
        );

    } else {

        console.log(
            "ℹ️ Membership changed while sending 7-day reminder:",
            userId
        );
    }
}

// ==========================================
// CHECK 1-DAY REMINDER
// ==========================================

async function processOneDayReminder(
    membership
) {

    const freshMembership =
        getMembershipById(
            membership.id
        );

    if (
        !freshMembership ||
        freshMembership.status !== "active"
    ) {
        return;
    }

    const now =
        new Date();

    const end =
        new Date(
            freshMembership.membership_end
        );

    const oneDayBefore =
        new Date(
            end
        );

    oneDayBefore.setDate(
        oneDayBefore.getDate() - 1
    );

    if (
        now < oneDayBefore ||
        now >= end ||
        freshMembership.reminder_1_sent !== 0
    ) {
        return;
    }

    const userId =
        freshMembership.telegram_user_id;

    console.log(
        "⚠️ Sending 1-day renewal reminder:",
        userId
    );

    await sendMessage(
        userId,

        "⚠️ Your Dotopia membership expires tomorrow.\n\n" +
        "Renew now to keep your access to the private Dotopia channel.",

        true
    );

    // ======================================
    // Mark ONLY if the same membership is
    // still active and its expiry is unchanged.
    // ======================================

    const result =
        db.prepare(`
            UPDATE memberships
            SET reminder_1_sent = 1
            WHERE id = ?
              AND status = 'active'
              AND membership_end = ?
              AND reminder_1_sent = 0
        `).run(
            freshMembership.id,
            freshMembership.membership_end
        );

    if (
        result.changes === 1
    ) {

        console.log(
            "✅ 1-day reminder marked as sent:",
            userId
        );

    } else {

        console.log(
            "ℹ️ Membership changed while sending 1-day reminder:",
            userId
        );
    }
}

// ==========================================
// HANDLE EXPIRY
// ==========================================

async function processExpiry(
    membership
) {

    // ======================================
    // ALWAYS RELOAD BEFORE EXPIRY ACTION
    // ======================================

    let freshMembership =
        getMembershipById(
            membership.id
        );

    if (
        !freshMembership ||
        freshMembership.status !== "active"
    ) {
        return;
    }

    let now =
        new Date();

    let end =
        new Date(
            freshMembership.membership_end
        );

    if (
        now < end
    ) {
        return;
    }

    const userId =
        freshMembership.telegram_user_id;

    const originalExpiry =
        freshMembership.membership_end;

    console.log(
        "⌛ Membership expired:",
        freshMembership.id,
        "User:",
        userId
    );

    // ======================================
    // FINAL CHECK BEFORE REMOVAL
    // ======================================

    freshMembership =
        getMembershipById(
            membership.id
        );

    if (
        !freshMembership ||
        freshMembership.status !== "active"
    ) {
        console.log(
            "ℹ️ Membership changed before removal:",
            userId
        );

        return;
    }

    now =
        new Date();

    end =
        new Date(
            freshMembership.membership_end
        );

    if (
        now < end
    ) {

        console.log(
            "🔄 Membership was renewed before removal:",
            userId
        );

        return;
    }

    // ======================================
    // REMOVE FROM TELEGRAM
    // ======================================

    try {

        await removeFromChannel(
            userId
        );

    } catch (error) {

        console.error(
            "❌ Could not remove user from channel:",
            userId
        );

        console.error(
            error.message
        );

        // IMPORTANT:
        // Keep membership active so the next
        // checker cycle can retry.

        return;
    }

    // ======================================
    // CHECK FOR CONCURRENT RENEWAL
    // ======================================

    const afterRemoval =
        getMembershipById(
            membership.id
        );

    if (
        !afterRemoval
    ) {
        return;
    }

    const renewedDuringRemoval =
        afterRemoval.status === "active" &&
        afterRemoval.membership_end !==
            originalExpiry &&
        new Date(
            afterRemoval.membership_end
        ) > new Date();

    if (
        renewedDuringRemoval
    ) {

        console.log(
            "🔄 Membership was renewed during expiry removal:",
            userId
        );

        try {

            // ==================================
            // User was temporarily banned/unbanned.
            // Create a fresh invite using the NEW
            // membership expiry.
            // ==================================

            const freshInvite =
                await createInviteLink(
                    afterRemoval.membership_end
                );

            db.prepare(`
                UPDATE memberships
                SET invite_link = ?
                WHERE id = ?
                  AND status = 'active'
            `).run(
                freshInvite,
                afterRemoval.id
            );

            await sendRestoredAccess(
                userId,
                freshInvite
            );

            console.log(
                "✅ Access restored after concurrent renewal:",
                userId
            );

        } catch (error) {

            console.error(
                "❌ Could not restore renewed member access:",
                userId
            );

            console.error(
                error.message
            );
        }

        return;
    }

    // ======================================
    // MARK MEMBERSHIP EXPIRED
    //
    // Conditional update prevents an old
    // checker state from expiring a renewed
    // membership.
    // ======================================

    const expireResult =
        db.prepare(`
            UPDATE memberships
            SET status = 'expired'
            WHERE id = ?
              AND status = 'active'
              AND membership_end = ?
        `).run(
            membership.id,
            originalExpiry
        );

    if (
        expireResult.changes !== 1
    ) {

        console.log(
            "⚠️ Membership changed before expiry could be committed:",
            userId
        );

        // ==================================
        // Defensive restoration:
        // If it became active with a new expiry,
        // provide a fresh invite.
        // ==================================

        const changedMembership =
            getMembershipById(
                membership.id
            );

        if (
            changedMembership &&
            changedMembership.status === "active" &&
            new Date(
                changedMembership.membership_end
            ) > new Date()
        ) {

            try {

                const freshInvite =
                    await createInviteLink(
                        changedMembership.membership_end
                    );

                db.prepare(`
                    UPDATE memberships
                    SET invite_link = ?
                    WHERE id = ?
                      AND status = 'active'
                `).run(
                    freshInvite,
                    changedMembership.id
                );

                await sendRestoredAccess(
                    userId,
                    freshInvite
                );

                console.log(
                    "✅ Access restored after membership state changed:",
                    userId
                );

            } catch (error) {

                console.error(
                    "❌ Defensive access restoration failed:",
                    error.message
                );
            }
        }

        return;
    }

    console.log(
        "✅ Membership marked as expired:",
        membership.id
    );

    // ======================================
    // SEND EXPIRY NOTIFICATION
    // ======================================

    if (
        freshMembership.expiry_notification_sent === 0
    ) {

        try {

            await sendMessage(
                userId,

                "🔒 Your Dotopia membership has expired.\n\n" +
                "Your access to the private channel has been removed.\n\n" +
                "You can renew your membership below to regain access.",

                true
            );

            // ==================================
            // Only mark sent AFTER Telegram
            // successfully accepted the message.
            // ==================================

            db.prepare(`
                UPDATE memberships
                SET expiry_notification_sent = 1
                WHERE id = ?
                  AND status = 'expired'
                  AND expiry_notification_sent = 0
            `).run(
                membership.id
            );

            console.log(
                "📨 Expiry notification marked as sent:",
                userId
            );

        } catch (error) {

            console.error(
                "⚠️ Could not send expiry message:",
                error.message
            );

            // Leave expiry_notification_sent = 0.
            // The next checker cycle can retry.
        }
    }
}

// ==========================================
// MAIN MEMBERSHIP CHECK
// ==========================================

async function checkMemberships() {

    try {

        const now =
            new Date();

        console.log(
            `🔍 Membership check: ${now.toISOString()}`
        );

        const memberships =
            db.prepare(`
                SELECT *
                FROM memberships
                WHERE status = 'active'
            `).all();

        console.log(
            `👥 Active memberships: ${memberships.length}`
        );

        for (
            const membership
            of memberships
        ) {

            try {

                // ==================================
                // 7-DAY REMINDER
                // ==================================

                await processSevenDayReminder(
                    membership
                );

                // ==================================
                // 1-DAY REMINDER
                // ==================================

                await processOneDayReminder(
                    membership
                );

                // ==================================
                // EXPIRY
                // ==================================

                await processExpiry(
                    membership
                );

            } catch (error) {

                console.error(
                    "❌ Error processing membership:",
                    membership.id
                );

                console.error(
                    error.message
                );
            }
        }

    } catch (error) {

        console.error(
            "❌ Membership checker error:"
        );

        console.error(
            error
        );
    }
}

// ==========================================
// START CHECKER
// ==========================================

console.log("");

console.log(
    "=========================================="
);

console.log(
    "⏰ Dotopia membership checker is running"
);

console.log(
    "=========================================="
);

console.log(
    "📢 Channel:",
    TELEGRAM_CHANNEL_ID
);

console.log(
    "🔄 Checking every 60 seconds"
);

console.log(
    "🛡️ Stale-state protection: enabled"
);

console.log(
    "🔄 Renewal race protection: enabled"
);

console.log(
    "📨 Notification retry protection: enabled"
);

console.log(
    "=========================================="
);

console.log("");

checkMemberships();

setInterval(
    checkMemberships,
    CHECK_INTERVAL
);