const express = require("express");
const crypto = require("crypto");
const db = require("./database");

const router = express.Router();
const COOKIE_NAME = "dotopia_session";
const SESSION_DAYS = 30;

function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function nowIso() {
    return new Date().toISOString();
}

function cookieOptions(maxAge) {
    return [
        `${COOKIE_NAME}=${maxAge ? "" : ""}`,
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=None",
        `Max-Age=${maxAge}`
    ].join("; ");
}

function readCookie(req, name) {
    const header = req.headers.cookie || "";
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index < 0) continue;
        if (part.slice(0, index).trim() === name) {
            return decodeURIComponent(part.slice(index + 1).trim());
        }
    }
    return null;
}

// Restrict browser access to the configured website origin.
// Set WEBSITE_ORIGIN to the exact HTTPS origin, e.g. https://dotopia.example.
router.use((req, res, next) => {
    const allowedOrigin = process.env.WEBSITE_ORIGIN;
    const origin = req.headers.origin;

    if (origin && allowedOrigin && origin !== allowedOrigin) {
        return res.status(403).json({ error: "Origin not allowed." });
    }

    if (origin && allowedOrigin && origin === allowedOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }

    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

// Create a fresh one-time invitation. The plaintext code is returned
// only to the caller for immediate delivery through the Telegram bot.
function issueWebsiteInvitation(membershipId) {
    const membership = db.prepare(`
        SELECT id, membership_end, status
        FROM memberships
        WHERE id = ?
        LIMIT 1
    `).get(membershipId);

    if (!membership || membership.status !== "active" ||
        new Date(membership.membership_end) <= new Date()) {
        throw new Error("Cannot issue a website invitation for an inactive membership.");
    }

    const code = crypto.randomBytes(18).toString("base64url").toUpperCase();
    const tokenHash = sha256(code);
    const expiresAt = new Date(membership.membership_end).toISOString();

    const issue = db.transaction(() => {
        db.prepare(`
            UPDATE website_invitations
            SET status = 'revoked'
            WHERE membership_id = ? AND status = 'issued'
        `).run(membershipId);

        db.prepare(`
            INSERT INTO website_invitations
                (membership_id, token_hash, status, expires_at)
            VALUES (?, ?, 'issued', ?)
        `).run(membershipId, tokenHash, expiresAt);
    });

    issue();
    return code;
}

router.post("/redeem", (req, res) => {
    try {
        const rawCode = typeof req.body?.code === "string" ? req.body.code.trim() : "";
        if (!/^[A-Z0-9_-]{20,64}$/i.test(rawCode)) {
            return res.status(400).json({ error: "Enter a valid invitation code." });
        }

        const codeHash = sha256(rawCode.toUpperCase());
        const sessionToken = crypto.randomBytes(32).toString("base64url");
        const sessionHash = sha256(sessionToken);

        const redeem = db.transaction(() => {
            const invitation = db.prepare(`
                SELECT i.id, i.membership_id, i.expires_at,
                       m.status AS membership_status, m.membership_end
                FROM website_invitations i
                JOIN memberships m ON m.id = i.membership_id
                WHERE i.token_hash = ? AND i.status = 'issued'
                LIMIT 1
            `).get(codeHash);

            if (!invitation ||
                invitation.membership_status !== "active" ||
                new Date(invitation.expires_at) <= new Date() ||
                new Date(invitation.membership_end) <= new Date()) {
                return false;
            }

            const changed = db.prepare(`
                UPDATE website_invitations
                SET status = 'redeemed', redeemed_at = ?
                WHERE id = ? AND status = 'issued'
            `).run(nowIso(), invitation.id);

            if (changed.changes !== 1) return false;

            const sessionExpiry = new Date(Math.min(
                Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
                new Date(invitation.membership_end).getTime()
            )).toISOString();

            db.prepare(`
                INSERT INTO website_sessions
                    (membership_id, session_hash, expires_at)
                VALUES (?, ?, ?)
            `).run(invitation.membership_id, sessionHash, sessionExpiry);

            return { membershipId: invitation.membership_id, expiresAt: sessionExpiry };
        });

        const result = redeem();
        if (!result) {
            return res.status(400).json({
                error: "This invitation is invalid, expired, or has already been used."
            });
        }

        const maxAge = Math.max(0, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000));
        res.setHeader("Set-Cookie", [
            `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`
        ]);
        return res.json({ success: true, redirect: "/members.html" });
    } catch (error) {
        console.error("Website invitation redemption failed:", error);
        return res.status(500).json({ error: "Unable to redeem invitation right now." });
    }
});

router.get("/me", (req, res) => {
    try {
        const token = readCookie(req, COOKIE_NAME);
        if (!token) return res.status(401).json({ authenticated: false });

        const session = db.prepare(`
            SELECT s.id AS session_id, s.expires_at,
                   m.id AS membership_id, m.status, m.membership_end
            FROM website_sessions s
            JOIN memberships m ON m.id = s.membership_id
            WHERE s.session_hash = ? AND s.revoked_at IS NULL
            LIMIT 1
        `).get(sha256(token));

        if (!session || session.status !== "active" ||
            new Date(session.expires_at) <= new Date() ||
            new Date(session.membership_end) <= new Date()) {
            if (session) {
                db.prepare("UPDATE website_sessions SET revoked_at = ? WHERE id = ?")
                    .run(nowIso(), session.session_id);
            }
            res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`);
            return res.status(401).json({ authenticated: false });
        }

        return res.json({
            authenticated: true,
            membershipEndsAt: session.membership_end
        });
    } catch (error) {
        console.error("Website session check failed:", error);
        return res.status(500).json({ error: "Unable to verify membership." });
    }
});

router.post("/logout", (req, res) => {
    const token = readCookie(req, COOKIE_NAME);
    if (token) {
        db.prepare(`
            UPDATE website_sessions SET revoked_at = ?
            WHERE session_hash = ? AND revoked_at IS NULL
        `).run(nowIso(), sha256(token));
    }
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`);
    return res.json({ success: true });
});

module.exports = { router, issueWebsiteInvitation };
