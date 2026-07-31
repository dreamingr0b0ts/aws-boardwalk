// The tripwire responder. EventBridge invokes this the moment CloudTrail
// reports an AuthorizeSecurityGroupIngress on the sandbox group (the drift the
// practice-smoke drill deliberately introduces). It revokes the open rule
// automatically — the "response" half of detect-and-respond. Its own
// RevokeSecurityGroupIngress call lands in the same CloudTrail, so the audit
// trail captures the responder too.
//
// Scope is fenced two ways: the EventBridge rule only matches the sandbox
// group's id, and this role's IAM only permits revoke on the group tagged
// exhibit=practice-smoke. It cannot touch any other security group.
import {
  EC2Client, DescribeSecurityGroupsCommand, RevokeSecurityGroupIngressCommand,
} from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({});
const { SANDBOX_SG_ID } = process.env;

export const handler = async (event) => {
  const groupId = event?.detail?.requestParameters?.groupId ?? SANDBOX_SG_ID;
  if (groupId !== SANDBOX_SG_ID) {
    console.log(`ignoring event for ${groupId}; responder guards ${SANDBOX_SG_ID} only`);
    return { revoked: false, reason: "not the sandbox group" };
  }

  // Revoke every ingress rule currently on the group. At steady state the only
  // rule present is the drill's world-open SSH; sweeping all ingress is the
  // robust close.
  const res = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [SANDBOX_SG_ID] }));
  const perms = res.SecurityGroups?.[0]?.IpPermissions ?? [];
  if (perms.length === 0) {
    return { revoked: false, reason: "already closed" };
  }

  try {
    await ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: SANDBOX_SG_ID, IpPermissions: perms }));
    console.log(`tripwire revoked ${perms.length} ingress rule(s) on ${SANDBOX_SG_ID}`);
    return { revoked: true, rules: perms.length };
  } catch (err) {
    if (err.name === "InvalidPermission.NotFound") {
      return { revoked: false, reason: "already closed" };
    }
    throw err;
  }
};
