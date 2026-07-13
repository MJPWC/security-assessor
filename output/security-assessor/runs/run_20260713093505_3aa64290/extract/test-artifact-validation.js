import {
  validateMuleProjectArtifact,
  validateRamlArtifact
} from './server/artifactValidation.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const validRaml = validateRamlArtifact(`#%RAML 1.0
title: Hello API
version: v1
/hello:
  get:
    responses:
      200:
        body:
          application/json:
            example: { "message": "hello" }
`);
assert(validRaml.valid, 'Valid RAML should pass validation');

const repairedGeneratedSecretRaml = validateRamlArtifact(`#%RAML 1.0
title: Generated API
clientSecret: real-secret-value
authToken: real-token-value
Authorization: "Bearer generated-token-value"
`);
assert(repairedGeneratedSecretRaml.valid, 'Generated RAML credential-like assignments should be repaired to placeholders');
assert(repairedGeneratedSecretRaml.value.includes('clientSecret: ${secure::clientsecret}'), 'Generated RAML client secret should become a secure placeholder');
assert(repairedGeneratedSecretRaml.value.includes('authToken: ${secure::authtoken}'), 'Generated RAML auth token should become a secure placeholder');
assert(repairedGeneratedSecretRaml.value.includes('Authorization: "${secure::authorization}"'), 'Generated RAML authorization value should become a secure placeholder');

const repairedSampleSecretRaml = validateRamlArtifact(`#%RAML 1.0
title: Sample API
password: 12345
clientSecret: sample-secret-value
apiKey: "abc123"
token: "sample token value"
`);
assert(repairedSampleSecretRaml.valid, 'RAML with obvious sample secret values should be repaired to placeholders');
assert(repairedSampleSecretRaml.value.includes('password: ${secure::password}'), 'Sample RAML password should become a secure placeholder');
assert(repairedSampleSecretRaml.value.includes('clientSecret: ${secure::clientsecret}'), 'Sample RAML client secret should become a secure placeholder');
assert(repairedSampleSecretRaml.value.includes('apiKey: "${secure::apikey}"'), 'Quoted sample RAML api key should become a secure placeholder');
assert(repairedSampleSecretRaml.value.includes('token: "${secure::token}"'), 'Quoted sample RAML token should become a secure placeholder');

const validOAuthRaml = validateRamlArtifact(`#%RAML 1.0
title: OAuth API
securitySchemes:
  oauth_2_0:
    type: OAuth 2.0
    describedBy:
      headers:
        Authorization:
          type: string
      responses:
        401:
          description: Unauthorized
    settings:
      authorizationUri: https://auth.example.com/authorize
      accessTokenUri: https://auth.example.com/token
      authorizationGrants: [ client_credentials ]
types:
  TokenResponse:
    type: object
    properties:
      access_token: string
      token_type: string
      expires_in: integer
`);
assert(validOAuthRaml.valid, 'RAML OAuth URI/settings and token schema fields should pass validation');

const invalidTokenRaml = validateRamlArtifact(`#%RAML 1.0
title: Unsafe Token API
authToken: real-token-value
`);
assert(invalidTokenRaml.valid, 'Generated RAML hardcoded-looking token should be repaired instead of blocked');
assert(invalidTokenRaml.value.includes('authToken: ${secure::authtoken}'), 'Generated RAML token should become a secure placeholder');

const validMuleProject = validateMuleProjectArtifact({
  files: [
    {
      path: 'pom.xml',
      content: '<project><modelVersion>4.0.0</modelVersion></project>'
    },
    {
      path: 'src/main/resources/api/hello.raml',
      content: '#%RAML 1.0\ntitle: Hello API\n'
    },
    {
      path: 'src/main/resources/application.properties',
      content: 'http.port=${http.port:8081}\n# database.password=your_database_password\n'
    }
  ]
});
assert(validMuleProject.valid, 'Valid Mule project should pass validation');
assert(validMuleProject.value.files[1].path === 'src/main/resources/api/hello.raml', 'Safe paths should be preserved');

const unsafePathProject = validateMuleProjectArtifact({
  files: [{ path: '../evil.txt', content: 'bad' }]
});
assert(!unsafePathProject.valid, 'Path traversal should fail validation');

const hardcodedSecretProject = validateMuleProjectArtifact({
  files: [{ path: 'src/main/resources/application.properties', content: 'db.password=superSecret123\n' }]
});
assert(!hardcodedSecretProject.valid, 'Hardcoded credentials should fail validation');

const hardcodedXmlSecretProject = validateMuleProjectArtifact({
  files: [{ path: 'src/main/mule/global.xml', content: '<db:config password="superSecret123" />' }]
});
assert(!hardcodedXmlSecretProject.valid, 'Hardcoded XML credential attributes should fail validation');

console.log('Artifact validation tests passed');
