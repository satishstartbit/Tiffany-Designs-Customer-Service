import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import requestCall from '@salesforce/apex/TiffanyVoiceCallController.requestCall';

const GENERIC_ERROR = 'Calls are unavailable right now. Please try again later or use the chat.';
// On these record pages the panel offers the record's own number.
const PREFILL_OBJECTS = new Set(['Contact', 'Lead']);

export default class TiffanyVoiceCall extends LightningElement {
    @api recordId;
    @api objectApiName;
    @api heading = 'Talk to Tiffany Designs';
    @api subheading = 'Satish Choudhary, our AI assistant, calls you right away';
    @api buttonLabel = 'Call me now';

    phone = '';
    consent = false;
    busy = false;
    started = false;
    errorText = '';
    successText = '';
    recordName;

    get prefillRecordId() {
        return PREFILL_OBJECTS.has(this.objectApiName) ? this.recordId : undefined;
    }

    get prefillFields() {
        return ['MobilePhone', 'Phone', 'Name'].map((field) => `${this.objectApiName}.${field}`);
    }

    @wire(getRecord, { recordId: '$prefillRecordId', optionalFields: '$prefillFields' })
    wiredRecord({ data }) {
        if (!data) {
            return;
        }
        const value = (field) => getFieldValue(data, `${this.objectApiName}.${field}`);
        this.recordName = value('Name') || undefined;
        if (!this.phone) {
            this.phone = value('MobilePhone') || value('Phone') || '';
        }
    }

    get digits() {
        return (this.phone || '').replace(/\D/g, '');
    }

    get callDisabled() {
        return this.busy || !this.consent || this.digits.length < 10;
    }

    get buttonText() {
        return this.busy ? 'Connecting…' : this.buttonLabel;
    }

    handlePhone(event) {
        this.phone = event.target.value;
        this.errorText = '';
    }

    handleConsent(event) {
        this.consent = event.target.checked;
        this.errorText = '';
    }

    async handleCall() {
        if (this.callDisabled) {
            return;
        }
        this.busy = true;
        this.errorText = '';
        try {
            const result = await requestCall({
                phone: this.phone,
                consent: this.consent,
                name: this.recordName,
                recordId: this.recordId
            });
            this.successText = (result && result.message) || 'Satish Choudhary, our AI assistant, is calling you now.';
            this.started = true;
        } catch (error) {
            this.errorText = (error && error.body && error.body.message) || GENERIC_ERROR;
        } finally {
            this.busy = false;
        }
    }

    handleReset() {
        this.started = false;
        this.consent = false;
        this.successText = '';
        this.errorText = '';
    }
}
