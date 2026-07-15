import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});

// Every confirmed self-signup becomes a citizen — RBAC is always explicit,
// never "no group means default".
export const handler = async (event: PostConfirmationTriggerEvent) => {
  if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: event.userPoolId,
        Username: event.userName,
        GroupName: 'citizen',
      })
    );
  }
  return event;
};
