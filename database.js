const Database = require("better-sqlite3");

const db = new Database("dotopia.db");

db.pragma("foreign_keys = ON");

// ==========================================
// MEMBERSHIPS TABLE
// ==========================================

db.exec(`
    CREATE TABLE IF NOT EXISTS memberships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        telegram_user_id TEXT NOT NULL,

        payment_id TEXT,
        payment_link_id TEXT,
        order_id TEXT,
        reference_id TEXT,

        amount_paise INTEGER NOT NULL,

        membership_start TEXT NOT NULL,
        membership_end TEXT NOT NULL,

        status TEXT NOT NULL DEFAULT 'active',

        invite_link TEXT,

        reminder_7_sent INTEGER NOT NULL DEFAULT 0,
        reminder_1_sent INTEGER NOT NULL DEFAULT 0,
        expiry_notification_sent INTEGER NOT NULL DEFAULT 0,

        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`);

// ==========================================
// MEMBERSHIP MIGRATIONS
// ==========================================

const membershipColumns =
    db.prepare(
        "PRAGMA table_info(memberships)"
    )
    .all()
    .map(
        column => column.name
    );

if (
    !membershipColumns.includes(
        "invite_link"
    )
) {

    db.exec(`
        ALTER TABLE memberships
        ADD COLUMN invite_link TEXT
    `);

    console.log(
        "🆕 Added invite_link"
    );
}

if (
    !membershipColumns.includes(
        "reminder_7_sent"
    )
) {

    db.exec(`
        ALTER TABLE memberships
        ADD COLUMN reminder_7_sent INTEGER NOT NULL DEFAULT 0
    `);

    console.log(
        "🆕 Added reminder_7_sent"
    );
}

if (
    !membershipColumns.includes(
        "reminder_1_sent"
    )
) {

    db.exec(`
        ALTER TABLE memberships
        ADD COLUMN reminder_1_sent INTEGER NOT NULL DEFAULT 0
    `);

    console.log(
        "🆕 Added reminder_1_sent"
    );
}

if (
    !membershipColumns.includes(
        "expiry_notification_sent"
    )
) {

    db.exec(`
        ALTER TABLE memberships
        ADD COLUMN expiry_notification_sent INTEGER NOT NULL DEFAULT 0
    `);

    console.log(
        "🆕 Added expiry_notification_sent"
    );
}

// ==========================================
// PAYMENTS TABLE
// ==========================================

db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        telegram_user_id TEXT NOT NULL,

        payment_id TEXT NOT NULL UNIQUE,
        payment_link_id TEXT,
        order_id TEXT,
        reference_id TEXT,

        amount_paise INTEGER NOT NULL,

        payment_status TEXT NOT NULL DEFAULT 'paid',

        razorpay_event_id TEXT UNIQUE,

        fulfillment_status TEXT NOT NULL DEFAULT 'processing',

        membership_id INTEGER,

        fulfillment_type TEXT,

        last_error TEXT,

        recovery_attempted_at TEXT,

        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (
            membership_id
        )
        REFERENCES memberships(id)
    );
`);

// ==========================================
// PAYMENT MIGRATIONS
// ==========================================

const paymentColumns =
    db.prepare(
        "PRAGMA table_info(payments)"
    )
    .all()
    .map(
        column => column.name
    );

if (
    !paymentColumns.includes(
        "fulfillment_status"
    )
) {

    db.exec(`
        ALTER TABLE payments
        ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'processing'
    `);

    console.log(
        "🆕 Added fulfillment_status"
    );
}

if (
    !paymentColumns.includes(
        "membership_id"
    )
) {

    db.exec(`
        ALTER TABLE payments
        ADD COLUMN membership_id INTEGER
    `);

    console.log(
        "🆕 Added membership_id"
    );
}

if (
    !paymentColumns.includes(
        "fulfillment_type"
    )
) {

    db.exec(`
        ALTER TABLE payments
        ADD COLUMN fulfillment_type TEXT
    `);

    console.log(
        "🆕 Added fulfillment_type"
    );
}

if (
    !paymentColumns.includes(
        "last_error"
    )
) {

    db.exec(`
        ALTER TABLE payments
        ADD COLUMN last_error TEXT
    `);

    console.log(
        "🆕 Added last_error"
    );
}

if (
    !paymentColumns.includes(
        "recovery_attempted_at"
    )
) {

    db.exec(`
        ALTER TABLE payments
        ADD COLUMN recovery_attempted_at TEXT
    `);

    console.log(
        "🆕 Added recovery_attempted_at"
    );
}

// ==========================================
// INDEXES
// ==========================================

db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_memberships_telegram_user
    ON memberships(telegram_user_id);
`);

db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_memberships_status_end
    ON memberships(status, membership_end);
`);

db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_payments_telegram_user
    ON payments(telegram_user_id);
`);

db.exec(`
    CREATE INDEX IF NOT EXISTS
    idx_payments_fulfillment_status
    ON payments(fulfillment_status);
`);

console.log(
    "✅ Dotopia database initialized"
);

module.exports = db;