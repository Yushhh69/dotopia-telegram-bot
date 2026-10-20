require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const Razorpay = require("razorpay");

const db = require("./database");

const bot = new Telegraf(
    process.env.BOT_TOKEN
);

const razorpay = new Razorpay({
    key_id:
        process.env.RAZORPAY_KEY_ID,

    key_secret:
        process.env.RAZORPAY_KEY_SECRET,
});

// ==========================================
// PAYMENT AMOUNT
// ==========================================
//
// Amount is stored in paise.
//
// PRODUCTION:
// 149900 = ₹1,499
// ==========================================

const MEMBERSHIP_AMOUNT = 149900;
const AUTOPAY_PLAN_ID = "plan_ToV39QZUp1PPAM";
const AUTOPAY_TOTAL_COUNT = 40;

// ==========================================
// MAIN MENU
// ==========================================

function mainMenu() {

    return Markup.inlineKeyboard([

        [
            Markup.button.callback(
                "🔐 Get Membership",
                "get_membership"
            )
        ],

        [
            Markup.button.callback(
                "👤 My Membership",
                "my_membership"
            )
        ],

        [
            Markup.button.callback(
                "🔄 Renew Membership",
                "renew_membership"
            )
        ],

        [
            Markup.button.callback(
                "ℹ️ How It Works",
                "how_it_works"
            )
        ],

        [
            Markup.button.callback(
                "❓ Help",
                "help"
            )
        ]

    ]);
}

// ==========================================
// FORMAT DATE
// ==========================================

function formatDate(
    value
) {

    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return "Unknown";
    }

    return date.toLocaleString(
        "en-IN",
        {
            dateStyle:
                "long",

            timeStyle:
                "short",

            timeZone:
                "Asia/Kolkata"
        }
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
        String(
            telegramUserId
        )
    );
}

// ==========================================
// GET MOST RECENT MEMBERSHIP
// ==========================================

function getLatestMembership(
    telegramUserId
) {

    return db.prepare(`
        SELECT *
        FROM memberships
        WHERE telegram_user_id = ?
        ORDER BY
            CASE
                WHEN status = 'active'
                THEN 0
                ELSE 1
            END,
            membership_end DESC
        LIMIT 1
    `).get(
        String(
            telegramUserId
        )
    );
}

// ==========================================
// START
// ==========================================

bot.start(
    async (ctx) => {

        console.log(
            "✅ /start received from:",
            ctx.from.username ||
            ctx.from.id
        );

        await ctx.reply(

            "👋 Welcome to Dotopia!\n\n" +

            "Get access to our exclusive private channel.\n\n" +

            "💎 Membership: 3 Months\n" +

            "💰 Price: ₹1,499\n\n" +

            "Choose an option below:",

            mainMenu()
        );
    }
);

// ==========================================
// GET MEMBERSHIP
// ==========================================

bot.action(
    "get_membership",
    async (ctx) => {

        await ctx.answerCbQuery();

        await ctx.reply(

            "🔐 Dotopia Membership\n\n" +

            "Get 3 months of access to the private Dotopia channel.\n\n" +

            "💰 Price: ₹1,499\n" +

            "⏳ Duration: 3 months\n\n" +

            "This is a 3-month membership payment.\n\n" +

            "Click below to continue.",

           
Markup.inlineKeyboard([

    [
        Markup.button.callback(
            "💳 Pay Once — ₹1,499",
            "payment"
        )
    ],

    [
        Markup.button.callback(
            "🔄 Subscribe with AutoPay",
            "autopay"
        )
    ],

    [
        Markup.button.callback(
            "⬅️ Back",
            "back_to_menu"
        )
    ]

])

        );
    }
);

// ==========================================
// MY MEMBERSHIP
// ==========================================

bot.action(
    "my_membership",
    async (ctx) => {

        await ctx.answerCbQuery();

        const telegramUserId =
            ctx.from.id;

        console.log(
            "👤 Membership requested by:",
            telegramUserId
        );

        const membership =
            getActiveMembership(
                telegramUserId
            );

        // ==================================
        // ACTIVE MEMBERSHIP
        // ==================================

        if (membership) {

            const now =
                new Date();

            const membershipEnd =
                new Date(
                    membership.membership_end
                );

            const membershipStart =
                new Date(
                    membership.membership_start
                );

            const difference =
                membershipEnd.getTime() -
                now.getTime();

            const daysRemaining =
                Math.max(
                    0,
                    Math.ceil(
                        difference /
                        (
                            1000 *
                            60 *
                            60 *
                            24
                        )
                    )
                );

            await ctx.reply(

                "👤 *Your Dotopia Membership*\n\n" +

                "🟢 *Status:* Active\n\n" +

                "📅 *Started:*\n" +
                formatDate(
                    membershipStart
                ) +

                "\n\n" +

                "⏳ *Expires:*\n" +
                formatDate(
                    membershipEnd
                ) +

                "\n\n" +

                `📆 *Days remaining:* ${daysRemaining}\n\n` +

                "Your private-channel access is currently active.",

                {
                    parse_mode:
                        "Markdown",

                    ...Markup.inlineKeyboard([

                        [
                            Markup.button.callback(
                                "🔄 Renew Membership",
                                "renew_membership"
                            )
                        ],

                        [
                            Markup.button.callback(
                                "⬅️ Back",
                                "back_to_menu"
                            )
                        ]

                    ])
                }
            );

            return;
        }

        // ==================================
        // NO ACTIVE MEMBERSHIP
        // ==================================

        const latest =
            getLatestMembership(
                telegramUserId
            );

        if (latest) {

            const latestEnd =
                new Date(
                    latest.membership_end
                );

            await ctx.reply(

                "👤 *Your Dotopia Membership*\n\n" +

                "🔴 *Status:* Expired\n\n" +

                "📅 *Expired:*\n" +
                formatDate(
                    latestEnd
                ) +

                "\n\n" +

                "Your private-channel access is no longer active.\n\n" +

                "Renew your membership to regain access.",

                {
                    parse_mode:
                        "Markdown",

                    ...Markup.inlineKeyboard([

                        [
                            Markup.button.callback(
                                "🔄 Renew Membership",
                                "renew_membership"
                            )
                        ],

                        [
                            Markup.button.callback(
                                "🔐 Get Membership",
                                "get_membership"
                            )
                        ],

                        [
                            Markup.button.callback(
                                "⬅️ Back",
                                "back_to_menu"
                            )
                        ]

                    ])
                }
            );

            return;
        }

        // ==================================
        // NO MEMBERSHIP RECORD
        // ==================================

        await ctx.reply(

            "👤 *Your Dotopia Membership*\n\n" +

            "You don't currently have a membership.\n\n" +

            "Get a 3-month membership to access the private Dotopia channel.",

            {
                parse_mode:
                    "Markdown",

                ...Markup.inlineKeyboard([

                    [
                        Markup.button.callback(
                            "🔐 Get Membership",
                            "get_membership"
                        )
                    ],

                    [
                        Markup.button.callback(
                            "⬅️ Back",
                            "back_to_menu"
                        )
                    ]

                ])
            }
        );
    }
);

// ==========================================
// RENEW MEMBERSHIP
// ==========================================

bot.action(
    "renew_membership",
    async (ctx) => {

        await ctx.answerCbQuery();

        const telegramUserId =
            ctx.from.id;

        const membership =
            getActiveMembership(
                telegramUserId
            );

        if (membership) {

            const expiry =
                new Date(
                    membership.membership_end
                );

            await ctx.reply(

                "🔄 *Renew Dotopia Membership*\n\n" +

                "Your current membership is still active.\n\n" +

                "📅 Current expiry:\n" +
                formatDate(
                    expiry
                ) +

                "\n\n" +

                "A successful renewal will extend your membership by another 3 months.\n\n" +

                "💰 Price: ₹1,499\n" +

                "⏳ Extension: 3 months",

                {
                    parse_mode:
                        "Markdown",

                    ...Markup.inlineKeyboard([

                        [
                            Markup.button.callback(
                                "💳 Renew for ₹1,499",
                                "payment"
                            )
                        ],

                        [
                            Markup.button.callback(
                                "⬅️ Back",
                                "back_to_menu"
                            )
                        ]

                    ])
                }
            );

            return;
        }

        await ctx.reply(

            "🔄 *Renew Dotopia Membership*\n\n" +

            "You don't currently have an active membership.\n\n" +

            "A successful payment will create a fresh 3-month membership.\n\n" +

            "💰 Price: ₹1,499",

            {
                parse_mode:
                    "Markdown",

                ...Markup.inlineKeyboard([

                    [
                        Markup.button.callback(
                            "💳 Get Membership for ₹1,499",
                            "payment"
                        )
                    ],

                    [
                        Markup.button.callback(
                            "⬅️ Back",
                            "back_to_menu"
                        )
                    ]

                ])
            }
        );
    }
);

// ==========================================
// HOW IT WORKS
// ==========================================

bot.action(
    "how_it_works",
    async (ctx) => {

        await ctx.answerCbQuery();

        await ctx.reply(

            "ℹ️ *How Dotopia Membership Works*\n\n" +

            "1️⃣ Choose the 3-month membership.\n\n" +

            "2️⃣ Complete the payment.\n\n" +

            "3️⃣ Your payment is verified automatically.\n\n" +

            "4️⃣ You'll receive private-channel access.\n\n" +

            "5️⃣ Your membership lasts for 3 months.\n\n" +

            "🔄 You can renew before or after your membership expires.",

            {
                parse_mode:
                    "Markdown",

                ...Markup.inlineKeyboard([

                    [
                        Markup.button.callback(
                            "🔐 Get Membership",
                            "get_membership"
                        )
                    ],

                    [
                        Markup.button.callback(
                            "👤 My Membership",
                            "my_membership"
                        )
                    ],

                    [
                        Markup.button.callback(
                            "🔄 Renew Membership",
                            "renew_membership"
                        )
                    ],

                    [
                        Markup.button.callback(
                            "⬅️ Back",
                            "back_to_menu"
                        )
                    ]

                ])
            }
        );
    }
);

// ==========================================
// HELP
// ==========================================

bot.action(
    "help",
    async (ctx) => {

        await ctx.answerCbQuery();

        await ctx.reply(

            "❓ *Need Help?*\n\n" +

            "If you have an issue with your membership or payment, please contact the Dotopia team for support.",

            {
                parse_mode:
                    "Markdown",

                ...Markup.inlineKeyboard([

                    [
                        Markup.button.callback(
                            "👤 My Membership",
                            "my_membership"
                        )
                    ],

                    [
                        Markup.button.callback(
                            "🔄 Renew Membership",
                            "renew_membership"
                        )
                    ],

                    [
                        Markup.button.callback(
                            "⬅️ Back",
                            "back_to_menu"
                        )
                    ]

                ])
            }
        );
    }
);

// ==========================================

 // ==========================================
 // CREATE RAZORPAY AUTOPAY SUBSCRIPTION
 // ==========================================

bot.action("autopay", async (ctx) => {
    await ctx.answerCbQuery();

    const telegramUserId = String(ctx.from.id);

    try {
        // Reuse an existing pending or active subscription
        // rather than creating duplicates on repeated clicks.
        const existing = db.prepare(`
            SELECT *
            FROM subscriptions
            WHERE telegram_user_id = ?
              AND status IN ('created', 'authenticated', 'active')
            ORDER BY id DESC
            LIMIT 1
        `).get(telegramUserId);

        if (existing && existing.short_url) {
            await ctx.reply(
                "🔄 You already have an AutoPay subscription link or subscription.\n\n" +
                "Continue here to complete authorization or view your subscription:",
                Markup.inlineKeyboard([
                    [
                        Markup.button.url(
                            "Continue to AutoPay",
                            existing.short_url
                        )
                    ],
                    [
                        Markup.button.callback(
                            "⬅️ Back",
                            "back_to_menu"
                        )
                    ]
                ])
            );
            return;
        }

        const subscription = await razorpay.subscriptions.create({
            plan_id: AUTOPAY_PLAN_ID,
            total_count: AUTOPAY_TOTAL_COUNT,
            quantity: 1,
            customer_notify: true,
            notes: {
                telegram_user_id: telegramUserId,
                membership: "3_months",
                amount: "1499",
                billing: "autopay"
            }
        });

        db.prepare(`
            INSERT INTO subscriptions (
                razorpay_subscription_id,
                telegram_user_id,
                plan_id,
                status,
                short_url
            )
            VALUES (?, ?, ?, ?, ?)
        `).run(
            subscription.id,
            telegramUserId,
            AUTOPAY_PLAN_ID,
            subscription.status || "created",
            subscription.short_url || null
        );

        if (!subscription.short_url) {
            throw new Error(
                "Razorpay did not return a subscription authorization URL."
            );
        }

        await ctx.reply(
            "🔄 *Dotopia AutoPay*\n\n" +
            "Amount: ₹1,499 every 3 months\n" +
            "Billing: Automatic recurring payments\n" +
            "Cancellation: You can cancel your subscription\n\n" +
            "Open Razorpay to review the subscription and complete the required authorization.\n\n" +
            "Your membership will be activated or extended only after the relevant payment is confirmed.",
            {
                parse_mode: "Markdown",
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.url(
                            "🔐 Authorize AutoPay",
                            subscription.short_url
                        )
                    ],
                    [
                        Markup.button.callback(
                            "👤 My Membership",
                            "my_membership"
                        )
                    ],
                    [
                        Markup.button.callback(
                            "⬅️ Back",
                            "back_to_menu"
                        )
                    ]
                ])
            }
        );

        console.log(
            "✅ AutoPay subscription created:",
            subscription.id,
            "for Telegram user:",
            telegramUserId
        );

    } catch (error) {
        console.error(
            "❌ AutoPay subscription creation failed:",
            error
        );

        await ctx.reply(
            "Sorry, we couldn't create your AutoPay subscription right now. " +
            "Please try again later or use the one-time payment option."
        );
    }
});

// CREATE RAZORPAY PAYMENT
// ==========================================

bot.action(
    "payment",
    async (ctx) => {

        await ctx.answerCbQuery();

        const telegramUserId =
            ctx.from.id;

        console.log(
            "Creating a ₹1,499 payment link for Telegram user:",
            telegramUserId
        );

        try {

            const paymentLink =
                await razorpay.paymentLink.create({

                    amount:
                        MEMBERSHIP_AMOUNT,

                    currency:
                        "INR",

                    description:
                        "Dotopia - 3 Month Membership",

                    reference_id:
                        `TG_${telegramUserId}_${Date.now()}`,

                    notes: {

                        telegram_user_id:
                            String(
                                telegramUserId
                            ),

                        membership:
                            "3_months",

                        amount:
                            "1499",

                        test_payment:
                            "false"
                    }
                });

            console.log(
                "✅ Payment link created:",
                paymentLink.id
            );

            await ctx.reply(

                "💳 *Payment Ready!*\n\n" +

                "Membership: 3 Months\n" +

                "Membership Amount: ₹1,499\n\n" +

                "Complete the payment using Razorpay.\n\n" +

                "After successful payment, your membership will be activated or extended automatically.",

                {
                    parse_mode:
                        "Markdown",

                    ...Markup.inlineKeyboard([

                        [
                            Markup.button.url(
                                "💳 Pay ₹1,499",
                                paymentLink.short_url
                            )
                        ],

                        [
                            Markup.button.callback(
                                "👤 My Membership",
                                "my_membership"
                            )
                        ],

                        [
                            Markup.button.callback(
                                "⬅️ Back",
                                "back_to_menu"
                            )
                        ]

                    ])
                }
            );

        } catch (error) {

            console.error(
                "❌ Razorpay payment link error:"
            );

            console.error(
                error
            );

            await ctx.reply(

                "❌ Something went wrong while creating the payment link.\n\n" +

                "Please try again.",

                Markup.inlineKeyboard([

                    [
                        Markup.button.callback(
                            "🔄 Try Again",
                            "payment"
                        )
                    ],

                    [
                        Markup.button.callback(
                            "⬅️ Back",
                            "back_to_menu"
                        )
                    ]

                ])
            );
        }
    }
);

// ==========================================
// BACK TO MENU
// ==========================================

bot.action(
    "back_to_menu",
    async (ctx) => {

        await ctx.answerCbQuery();

        await ctx.reply(

            "👋 Welcome back to Dotopia!\n\n" +

            "Choose an option below:",

            mainMenu()
        );
    }
);

// ==========================================
// FORWARDED CHANNEL MESSAGE DETECTION
// ==========================================

bot.on(
    "message",
    async (ctx) => {

        const msg =
            ctx.message;

        console.log(
            "📩 Message received:",
            msg.text ||
            "[non-text message]"
        );

        if (
            msg.forward_origin &&
            msg.forward_origin.type ===
                "channel"
        ) {

            console.log(
                "📢 FORWARDED CHANNEL MESSAGE"
            );

            console.log(
                "Channel name:",
                msg.forward_origin.chat.title
            );

            console.log(
                "Channel ID:",
                msg.forward_origin.chat.id
            );

            console.log(
                "Original message ID:",
                msg.forward_origin.message_id
            );
        }
    }
);

// ==========================================
// CHANNEL POST DETECTION
// ==========================================

bot.on(
    "channel_post",
    (ctx) => {

        console.log(
            "📢 CHANNEL MESSAGE RECEIVED"
        );

        console.log(
            "Channel:",
            ctx.chat.title ||
            "Unknown"
        );

        console.log(
            "Channel ID:",
            ctx.chat.id
        );

        console.log(
            "Message ID:",
            ctx.channelPost.message_id
        );
    }
);

// ==========================================
// ERROR HANDLING
// ==========================================

bot.catch(
    (err) => {

        console.error(
            "❌ Bot error:",
            err
        );
    }
);

// ==========================================
// START BOT
// ==========================================

bot.launch()
    .then(
        () => {

            console.log(
                "🤖 Dotopia bot is running!"
            );

            console.log(
                "👤 My Membership: enabled"
            );

        }
    )
    .catch(
        (err) => {

            console.error(
                "❌ Failed to start bot:",
                err
            );
        }
    );

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

process.once(
    "SIGINT",
    () => {

        console.log(
            "🛑 Stopping bot..."
        );

        bot.stop(
            "SIGINT"
        );
    }
);

process.once(
    "SIGTERM",
    () => {

        console.log(
            "🛑 Stopping bot..."
        );

        bot.stop(
            "SIGTERM"
        );
    }
);