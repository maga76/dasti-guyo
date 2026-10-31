"""support messages

Revision ID: e9b3c5d71a42
Revises: d4f2a8c61b37
Create Date: 2026-10-31 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e9b3c5d71a42'
down_revision: Union[str, None] = 'd4f2a8c61b37'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('support_messages',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=True),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('message', sa.Text(), nullable=False),
    sa.Column('contact', sa.String(length=120), nullable=True),
    sa.Column('page', sa.String(length=40), nullable=True),
    sa.Column('user_agent', sa.String(length=300), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('support_messages', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_support_messages_user_id'), ['user_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_support_messages_status'), ['status'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('support_messages', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_support_messages_status'))
        batch_op.drop_index(batch_op.f('ix_support_messages_user_id'))

    op.drop_table('support_messages')
