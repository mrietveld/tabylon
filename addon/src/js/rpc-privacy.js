export function redactRpcMessageForLogging(message) {
    if (!message?.data?.action?.startsWith?.('Organizer.')) {
        return message;
    }

    return {
        postId: message.postId,
        data: {
            action: message.data.action,
            args: '[redacted]',
            breadcrumbs: '[redacted]',
        },
    };
}
