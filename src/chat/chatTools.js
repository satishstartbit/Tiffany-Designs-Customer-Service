const fs = require('fs');
const path = require('path');

// The voice agent's tools as the website chat uses them. Each tool's path, inputs, the inputs filled from the
// conversation's variables (caller_phone from customer_phone, order_phone) and the answer fields saved back come from
// sarvam/tools.json, so the chat calls the same /api/agent endpoints the voice agent does. The definitions the model
// reads are kept short: Groq's free plan allows 8,000 tokens a minute, and every request carries them.

const TOOLS_FILE = path.join(__dirname, '..', '..', 'sarvam', 'tools.json');

// The tools the chat offers and the inputs it may fill; a tool's other inputs stay empty.
const CHAT_TOOLS = {
  find_customer: ['Finds the customer, their orders and open requests: empty for this chat\'s number, or full name with PIN code.',
    ['phone', 'customer_name', 'postal_code']],
  find_order: ['Finds an order by id, number or invoice number; all empty for the orders on this chat\'s number.',
    ['order_id', 'order_number', 'invoice_number', 'phone', 'customer_name', 'postal_code', 'order_phone']],
  get_installation_address: ['City and PIN code of a found order\'s delivery address.', ['order_id', 'order_number']],
  resolve_date: ['Turns the customer\'s words for a day and time into a checked visiting date.', ['date_text', 'time_text']],
  book_installation: ['Registers or moves (reschedule) an installation for a confirmed order; updates an open one.',
    ['preferred_date', 'preferred_time', 'reschedule', 'at_delivery_address', 'use_details_on_file', 'phone', 'customer_name', 'order_id', 'order_number',
      'address', 'city', 'postal_code', 'use_calling_number', 'contact_number_ending']],
  register_service_request: ['Registers a part, damage, quality, replacement, return, follow-up or general request; updates an open one of the same kind.',
    ['issue_type', 'description', 'use_details_on_file', 'phone', 'customer_name', 'order_id', 'order_number', 'product_name', 'part_name', 'part_number',
      'quantity', 'address', 'city', 'postal_code', 'use_calling_number', 'contact_number_ending']],
  request_human_callback: ['Registers a call back from the service team.',
    ['reason', 'use_details_on_file', 'phone', 'customer_name', 'order_id', 'order_number', 'use_calling_number', 'contact_number_ending']],
  check_request_status: ['The customer\'s requests and what they noted: empty for this chat\'s number, or a request number with name or order id.',
    ['phone', 'case_number', 'customer_name', 'order_id']],
  get_product_guide: ['A product\'s guide: parts by sticker number, hardware by letter, counts, steps and rules.',
    ['order_id', 'order_number', 'product_name', 'purpose', 'item']],
  find_products: ['Products matching what the customer wants, with codes and list prices.', ['query']],
  place_order: ['Places a new order after the customer confirmed items, address and number.',
    ['customer_name', 'phone', 'items', 'address', 'city', 'postal_code', 'notes', 'use_calling_number', 'contact_number_ending']],
  send_invoice_upload_link: ['Sends a WhatsApp link to upload the invoice when the order cannot be found.',
    ['phone', 'customer_name', 'order_reference', 'use_calling_number']],
  check_invoice_upload: ['After the customer uploaded the invoice: the order it found or added.', ['phone']],
};

// Notes for the inputs that need one; the others explain themselves.
const INPUT_NOTES = {
  phone: 'Another 10 digit number; empty for this chat\'s number',
  order_phone: 'Number the customer says the order was placed with',
  use_calling_number: 'true for this chat\'s number',
  contact_number_ending: 'Last 4 digits the customer confirmed',
  use_details_on_file: 'true when the customer agreed to the details on file',
  at_delivery_address: 'true for the order\'s delivery address',
  reschedule: 'true to move an installation',
  preferred_date: 'YYYY-MM-DD from resolve_date',
  preferred_time: 'Time from resolve_date',
  date_text: 'The customer\'s words',
  item: 'One sticker number, letter, step, box or part name: 9, K, step 3, box 2, cam bolt',
  description: 'Each affected part with part number, quantity and problem',
  items: 'Product code x quantity, comma separated, e.g. TD-STD-01 x 1',
  customer_name: 'Full name, first and last',
};

const TOOL_OUTPUT_MAX = 2500;

// The chat's tool list for the model, and how to run a call: { definitions, run(name, args, vars, callTool) }, where
// callTool(path, body) POSTs to the server's own /api/agent and answers its JSON.
function createChatTools({ file = TOOLS_FILE } = {}) {
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8')).tools;
  const tools = Object.entries(CHAT_TOOLS).map(([name, [description, inputs]]) => {
    const spec = catalog.find((t) => t.name === name);
    if (!spec) throw new Error(`sarvam/tools.json has no tool ${name}`);
    return { name, description, inputs: inputs.filter((i) => spec.parameters.some((p) => p.name === i && !p.from_agent_variable)), spec };
  });

  const definitions = tools.map(({ name, description, inputs, spec }) => {
    const properties = {};
    const required = [];
    for (const input of inputs) {
      const p = spec.parameters.find((x) => x.name === input);
      properties[input] = {
        type: /bool/i.test(p.type) ? 'boolean' : /number|integer/i.test(p.type) ? 'number' : 'string',
        ...(p.one_of ? { enum: p.one_of } : {}),
        ...(INPUT_NOTES[input] ? { description: INPUT_NOTES[input] } : {}),
      };
      // A number stays optional: empty means this chat's number.
      if (p.required && input !== 'phone') required.push(input);
    }
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } } };
  });

  // Runs one call the model made: the inputs it may fill, plus the ones the conversation's variables fill, POSTed to
  // the tool's path. Answers what the model reads (the message and the fields the voice agent hears) and the
  // variables to save, as Sarvam's save_to_variables does.
  async function run(name, args, vars, callTool) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { text: `There is no tool called ${name}.`, saved: {} };
    const body = {};
    for (const input of tool.inputs) {
      const value = args?.[input];
      if (value !== undefined && value !== null && value !== '') body[input] = value;
    }
    for (const p of tool.spec.parameters) {
      if (p.from_agent_variable) body[p.name] = vars[p.from_agent_variable] || '';
    }
    let answer;
    try {
      answer = await callTool(tool.spec.path, body);
    } catch (err) {
      return { text: tool.spec.on_failure || `The tool did not answer (${err.message}). Apologise and offer a call back from the service team.`, saved: {} };
    }
    const fields = (tool.spec.send_to_agent || []).filter((f) => f !== 'message' && answer?.[f] !== undefined && answer?.[f] !== null)
      .map((f) => `${f}=${typeof answer[f] === 'object' ? JSON.stringify(answer[f]) : answer[f]}`);
    let text = `${answer?.message || ''}${fields.length ? `\nFields: ${fields.join(', ')}` : ''}`.trim() || 'The tool answered with nothing.';
    if (text.length > TOOL_OUTPUT_MAX) text = `${text.slice(0, TOOL_OUTPUT_MAX)}…`;
    const saved = {};
    for (const [variable, field] of Object.entries(tool.spec.save_to_variables || {})) {
      if (answer?.[field] !== undefined && answer?.[field] !== null && answer?.[field] !== '') saved[variable] = String(answer[field]);
    }
    return { text, saved };
  }

  return { definitions, run, names: tools.map((t) => t.name) };
}

module.exports = { createChatTools, CHAT_TOOLS };
