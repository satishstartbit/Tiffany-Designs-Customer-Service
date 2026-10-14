/**
 * "Call me" panel on the Tiffany Designs site: asks the voice server (Named Credential Tiffany_Voice_API) to have
 * the Sarvam voice assistant call the visitor now.
 *
 * The server enforces consent, valid Indian mobiles and the per-number and overall call limits, and words its
 * refusals for customers, so those are passed through; anything else becomes one generic message.
 */
public with sharing class TiffanyVoiceCallController {
    @TestVisible private static final String ENDPOINT = 'callout:Tiffany_Voice_API/api/calls/request';
    @TestVisible private static final String UNAVAILABLE = 'Calls are unavailable right now. Please try again later or use the chat.';
    private static final Pattern INDIAN_MOBILE = Pattern.compile('[6-9][0-9]{9}');
    private static final Pattern SAFE_NAME = Pattern.compile('[\\p{L} .\'-]{1,60}');
    private static final Set<Integer> CUSTOMER_FACING = new Set<Integer>{ 400, 403, 422, 429 };

    public class CallResult {
        @AuraEnabled public Boolean started;
        @AuraEnabled public String message;
    }

    @AuraEnabled
    public static CallResult requestCall(String phone, Boolean consent, String name, Id recordId) {
        if (consent != true) {
            throw customerError('Please tick the box to agree to the call.');
        }
        String mobile = tenDigitMobile(phone);
        if (mobile == null) {
            throw customerError('Please enter a valid 10-digit mobile number.');
        }

        HttpRequest req = new HttpRequest();
        req.setEndpoint(ENDPOINT);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(20000);
        req.setBody(JSON.serialize(new Map<String, Object>{
            'phone' => mobile,
            'consent' => true,
            'name' => customerName(name),
            'recordId' => recordId,
            'source' => recordId == null ? 'website' : 'salesforce'
        }));

        HttpResponse res;
        try {
            res = new Http().send(req);
        } catch (CalloutException e) {
            throw customerError(UNAVAILABLE);
        }

        Integer status = res.getStatusCode();
        if (status == 202) {
            CallResult result = new CallResult();
            result.started = true;
            result.message = 'Our assistant is calling the number ending ' + mobile.right(4) + ' now. Please keep your phone nearby.';
            return result;
        }
        String reason = CUSTOMER_FACING.contains(status) ? messageFrom(res.getBody()) : null;
        throw customerError(String.isBlank(reason) ? UNAVAILABLE : reason);
    }

    @TestVisible
    private static String tenDigitMobile(String phone) {
        if (String.isBlank(phone)) {
            return null;
        }
        String digits = phone.replaceAll('[^0-9]', '');
        if (digits.length() == 12 && digits.startsWith('91')) {
            digits = digits.substring(2);
        } else if (digits.length() == 11 && digits.startsWith('0')) {
            digits = digits.substring(1);
        }
        return INDIAN_MOBILE.matcher(digits).matches() ? digits : null;
    }

    // The assistant greets the person by this name, so a site guest cannot choose it.
    @TestVisible
    private static String customerName(String requested) {
        if (Auth.CommunitiesUtil.isGuestUser()) {
            return null;
        }
        String candidate = String.isNotBlank(requested) ? requested.trim() : null;
        if (candidate == null && UserInfo.getUserType() != 'Standard') {
            candidate = UserInfo.getName();
        }
        return candidate != null && SAFE_NAME.matcher(candidate).matches() ? candidate : null;
    }

    private static String messageFrom(String body) {
        try {
            Object message = ((Map<String, Object>) JSON.deserializeUntyped(body)).get('message');
            return message == null ? null : String.valueOf(message);
        } catch (Exception e) {
            return null;
        }
    }

    private static AuraHandledException customerError(String message) {
        AuraHandledException e = new AuraHandledException(message);
        e.setMessage(message);
        return e;
    }
}
