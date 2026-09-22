import os
import sys

# Load environment variables from .env if present
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Ensure Bedrock OpenAI-compatible endpoint is set
if not os.environ.get("OPENAI_BASE_URL"):
    os.environ["OPENAI_BASE_URL"] = "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"

# Allow fallback from AWS_BEARER_TOKEN_BEDROCK if OPENAI_API_KEY isn't explicitly set
if not os.environ.get("OPENAI_API_KEY") and os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
    os.environ["OPENAI_API_KEY"] = os.environ["AWS_BEARER_TOKEN_BEDROCK"]

from openai import OpenAI

def main():
    api_key = os.environ.get("OPENAI_API_KEY")
    base_url = os.environ.get("OPENAI_BASE_URL")

    if not api_key:
        print("Error: OPENAI_API_KEY (or AWS_BEARER_TOKEN_BEDROCK) is not set.")
        print("Please set your Bedrock API key in your environment or in .env.")
        sys.exit(1)

    print(f"Connecting to: {base_url}")
    print(f"API Key prefix: {api_key[:10]}...")

    client = OpenAI()

    # Step 5 - Run first inference request with Bedrock OpenAI endpoint
    try:
        response = client.responses.create(
            model="us.openai.gpt-5.6-terra",
            input="Can you explain the features of Amazon Bedrock?"
        )
        print("\n--- Response from Amazon Bedrock ---")
        print(response)
    except Exception as exc:
        print("\n--- Request failed ---")
        print(f"Error: {exc}")
        if "permission_denied_error" in str(exc) or "not available for this account" in str(exc):
            print("\nTroubleshooting tips:")
            print("1. In AWS Bedrock Console -> 'Model access', check if 'openai.gpt-5.6-terra' is enabled.")
            print("2. Verify IAM identity has 'bedrock:InvokeModel' on the default project:")
            print("   arn:aws:bedrock:{region}:{account-id}:project/default")
            print("3. Alternatively, you can test with cross-region profile 'global.openai.gpt-5.6-terra' or other models enabled in your Bedrock account.")

if __name__ == "__main__":
    main()
