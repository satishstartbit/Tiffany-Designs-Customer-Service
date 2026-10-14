@IsTest
private class TiffanyVoiceCallControllerTest {
    private class ServerMock implements HttpCalloutMock {
        private final Integer status;
        private final String body;
        HttpRequest received;

        ServerMock(Integer status, String body) {
            this.status = status;
            this.body = body;
        }

        public HttpResponse respond(HttpRequest req) {
            received = req;
            HttpResponse res = new HttpResponse();
            res.setStatusCode(status);
            res.setBody(body);
            return res;
        }
    }

    private class UnreachableServer implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            throw new CalloutException('Unable to reach the voice server');
        }
    }

    private static String errorFrom(String phone, Boolean consent) {
        try {
            TiffanyVoiceCallController.requestCall(phone, consent, null, null);
        } catch (AuraHandledException e) {
            return e.getMessage();
        }
        Assert.fail('Expected the request to be refused');
        return null;
    }

    @IsTest
    static void startsACallAndSendsWhatTheServerNeeds() {
        ServerMock server = new ServerMock(202, '{"queued":true,"mode":"instant","attemptId":"a1"}');
        Test.setMock(HttpCalloutMock.class, server);

        Test.startTest();
        TiffanyVoiceCallController.CallResult result = TiffanyVoiceCallController.requestCall('+91 98765 43210', true, 'Aarav Sharma', null);
        Test.stopTest();

        Assert.isTrue(result.started);
        Assert.isTrue(result.message.contains('ending 3210'), result.message);
        Assert.areEqual('POST', server.received.getMethod());
        Assert.areEqual(TiffanyVoiceCallController.ENDPOINT, server.received.getEndpoint());
        Map<String, Object> sent = (Map<String, Object>) JSON.deserializeUntyped(server.received.getBody());
        Assert.areEqual('9876543210', sent.get('phone'));
        Assert.areEqual(true, sent.get('consent'));
        Assert.areEqual('Aarav Sharma', sent.get('name'));
        Assert.areEqual('website', sent.get('source'));
    }

    @IsTest
    static void passesOnTheServersReasonForARefusal() {
        String reason = 'A call to this number was requested recently. Please try again in about 15 minutes.';
        Test.setMock(HttpCalloutMock.class, new ServerMock(429, '{"error":"rate_limited","message":"' + reason + '"}'));
        Assert.areEqual(reason, errorFrom('9876543210', true));
    }

    @IsTest
    static void hidesServerFailuresBehindOneMessage() {
        Test.setMock(HttpCalloutMock.class, new ServerMock(502, '{"error":"Upstream request failed","detail":"Sarvam rejected the API key"}'));
        Assert.areEqual(TiffanyVoiceCallController.UNAVAILABLE, errorFrom('9876543210', true));

        Test.setMock(HttpCalloutMock.class, new ServerMock(422, 'not json'));
        Assert.areEqual(TiffanyVoiceCallController.UNAVAILABLE, errorFrom('9876543210', true));
    }

    @IsTest
    static void handlesAnUnreachableServer() {
        Test.setMock(HttpCalloutMock.class, new UnreachableServer());
        Assert.areEqual(TiffanyVoiceCallController.UNAVAILABLE, errorFrom('9876543210', true));
    }

    @IsTest
    static void needsConsentBeforeCallingOut() {
        ServerMock server = new ServerMock(202, '{}');
        Test.setMock(HttpCalloutMock.class, server);
        Assert.areEqual('Please tick the box to agree to the call.', errorFrom('9876543210', false));
        Assert.areEqual('Please tick the box to agree to the call.', errorFrom('9876543210', null));
        Assert.isNull(server.received, 'no callout without consent');
    }

    @IsTest
    static void refusesNumbersThatAreNotIndianMobiles() {
        ServerMock server = new ServerMock(202, '{}');
        Test.setMock(HttpCalloutMock.class, server);
        for (String phone : new List<String>{ null, '', '12345', '1234567890', '+1 415 555 0100' }) {
            Assert.areEqual('Please enter a valid 10-digit mobile number.', errorFrom(phone, true));
        }
        Assert.isNull(server.received);
    }

    @IsTest
    static void acceptsTheWaysIndianMobilesAreWritten() {
        Assert.areEqual('9876543210', TiffanyVoiceCallController.tenDigitMobile('9876543210'));
        Assert.areEqual('9876543210', TiffanyVoiceCallController.tenDigitMobile('09876543210'));
        Assert.areEqual('9876543210', TiffanyVoiceCallController.tenDigitMobile('+91-98765-43210'));
        Assert.areEqual('9876543210', TiffanyVoiceCallController.tenDigitMobile('919876543210'));
    }

    @IsTest
    static void keepsOnlySafeNames() {
        Assert.areEqual('Aarav Sharma', TiffanyVoiceCallController.customerName(' Aarav Sharma '));
        Assert.areEqual('Meera D\'Souza', TiffanyVoiceCallController.customerName('Meera D\'Souza'));
        Assert.isNull(TiffanyVoiceCallController.customerName('<script>alert(1)</script>'));
        Assert.isNull(TiffanyVoiceCallController.customerName('x'.repeat(61)));
        Assert.isNull(TiffanyVoiceCallController.customerName(null), 'staff pages without a record name send none');
    }
}
