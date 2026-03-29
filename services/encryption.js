import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

// Получаем ключ динамически, чтобы избежать ошибок при инициализации импортов,
// если переменная окружения еще не успела подгрузиться
function getKey() {
    const keyHex = process.env.ENCRYPTION_KEY;
    
    if (!keyHex) {
        console.warn('⚠️ ВНИМАНИЕ: ENCRYPTION_KEY не установлен! Используется временный ключ (небезопасно для production).');
        // Генерируем временный ключ, чтобы избежать падения (краша) при запуске
        return crypto.randomBytes(32);
    }
    
    return Buffer.from(keyHex, 'hex');
}

export function encrypt(text) {
    if (!text) return text;
    const KEY = getKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(encryptedData) {
    if (!encryptedData || !encryptedData.includes(':')) return encryptedData; // Защита от расшифровки уже сырых данных/ошибок
    const KEY = getKey();
    const [ivHex, authTagHex, encryptedHex] = encryptedData.split(':');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return Buffer.concat([
        decipher.update(Buffer.from(encryptedHex, 'hex')), 
        decipher.final()
    ]).toString('utf8');
}