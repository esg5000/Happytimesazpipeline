"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSlug = generateSlug;
exports.ensureUniqueSlug = ensureUniqueSlug;
/**
 * Generates a URL-friendly slug from a title
 */
function generateSlug(title) {
    return title
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
        .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}
/**
 * Ensures slug uniqueness by appending a number if needed
 */
function ensureUniqueSlug(baseSlug, existingSlugs) {
    let slug = baseSlug;
    let counter = 1;
    while (existingSlugs.includes(slug)) {
        slug = `${baseSlug}-${counter}`;
        counter++;
    }
    return slug;
}
//# sourceMappingURL=slug.js.map