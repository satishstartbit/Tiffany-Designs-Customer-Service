// Sarvam tools pass plain text, so a phone order arrives as "TD-STD-01 x 1, TD-CHR-01 x 2".
const PRODUCT_CODE = /[A-Za-z]{2,}-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/;

function parseItems(text) {
  const pieces = String(text || '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const quantities = new Map();
  for (const piece of pieces) {
    const code = PRODUCT_CODE.exec(piece);
    if (!code) return { error: `No product code was given in "${piece}". Check the product with find_products.` };
    const quantity = /(\d+)/.exec(piece.replace(code[0], ' '));
    const key = code[0].toUpperCase();
    quantities.set(key, (quantities.get(key) || 0) + (quantity ? Number(quantity[1]) : 1));
  }
  return { items: [...quantities].map(([productCode, quantity]) => ({ productCode, quantity })) };
}

function formatRupees(amount) {
  return `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount)} rupees`;
}

module.exports = { parseItems, formatRupees };
